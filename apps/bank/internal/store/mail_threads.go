package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"slices"
	"strconv"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
)

type MailProjection struct {
	MessageID       string
	RawRef          string
	InReplyTo       []string
	References      []string
	NativeThreadID  string
	PreserveNative  bool
	PreserveHeaders bool
	Context         *archive.MailImportContext
}

type MailLimits struct{ Nodes, Edges, Messages int }

func MailGroupingLimits() (MailLimits, error) {
	limits := MailLimits{Nodes: 10000, Edges: 50000, Messages: 10000}
	for name, value := range map[string]*int{"BANK_MAIL_MAX_NODES": &limits.Nodes, "BANK_MAIL_MAX_EDGES": &limits.Edges, "BANK_MAIL_MAX_MESSAGES": &limits.Messages} {
		if raw := os.Getenv(name); raw != "" {
			parsed, err := strconv.Atoi(raw)
			if err != nil || parsed < 1 || parsed > 100000 {
				return limits, fmt.Errorf("%s must be 1..100000", name)
			}
			*value = parsed
		}
	}
	return limits, nil
}

type MailProjectionResult struct {
	ThreadID         string `json:"thread_id"`
	PreviousThreadID string `json:"previous_thread_id"`
	Incomplete       bool   `json:"incomplete"`
	Conflict         bool   `json:"conflict"`
}

type mailNode struct{ Key, ThreadID, Conflict string }
type mailHeaders struct {
	MessageID, RawRef     string
	InReplyTo, References []string
}
type mailMember struct {
	ID                    int64
	Key, Native, ThreadID string
}
type mailEdge struct {
	Owner       int64
	Left, Right string
}
type mailComponent struct {
	Keys               []string
	ThreadID, Conflict string
}

func mailDerivedID(key string) string {
	digest := sha256.Sum256([]byte(key))
	return "mail:" + hex.EncodeToString(digest[:])
}

func (s *Store) ProjectMail(ctx context.Context, id int64, projection MailProjection, apply bool, workKey string) (MailProjectionResult, error) {
	return s.projectMail(ctx, id, projection, apply, workKey, nil)
}

func (s *Store) projectMail(ctx context.Context, id int64, projection MailProjection, apply bool, workKey string, preview *MailPreview) (MailProjectionResult, error) {
	var result MailProjectionResult
	limits, err := MailGroupingLimits()
	if err != nil {
		return result, err
	}
	if projection.Context != nil {
		if err := projection.Context.Validate(); err != nil {
			return result, err
		}
	}
	options := pgx.TxOptions{}
	if !apply {
		options.AccessMode = pgx.ReadOnly
		options.IsoLevel = pgx.RepeatableRead
	}
	transaction, err := s.pool.BeginTx(ctx, options)
	if err != nil {
		return result, err
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	var message Message
	if err := message.scanFull(transaction.QueryRow(ctx, `select `+messageColumns+` from messages m where id=$1`, id)); err != nil {
		return result, err
	}
	if apply {
		if _, err := transaction.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1,814021))`, message.Source); err != nil {
			return result, err
		}
		if err := message.scanFull(transaction.QueryRow(ctx, `select `+messageColumns+` from messages m where id=$1 for update`, id)); err != nil {
			return result, err
		}
	}
	result.PreviousThreadID = message.ThreadID
	var previousKey, native string
	var headers mailHeaders
	err = transaction.QueryRow(ctx, `select node_key,native_thread_id,header_message_id,header_raw_ref,in_reply_to,reference_ids
		from mail_details where message_id=$1`, id).Scan(&previousKey, &native, &headers.MessageID, &headers.RawRef, &headers.InReplyTo, &headers.References)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	if errors.Is(err, pgx.ErrNoRows) {
		native = message.ThreadID
	}
	if preview != nil {
		if member, exists := preview.members[id]; exists {
			previousKey, native = member.Key, member.Native
			if proposed, exists := preview.headers[id]; exists {
				headers = proposed
			}
			node := preview.nodes[member.Key]
			result.PreviousThreadID = node.ThreadID
			if node.Conflict != "" {
				result.PreviousThreadID = native
			}
		}
	}
	if projection.PreserveHeaders && previousKey != "" {
		projection.MessageID, projection.RawRef = headers.MessageID, headers.RawRef
		projection.InReplyTo, projection.References = headers.InReplyTo, headers.References
	}
	key := "ref:" + message.Ref
	if projection.MessageID != "" {
		key = "rfc:" + projection.MessageID
	}
	if projection.NativeThreadID != "" && (!projection.PreserveNative || native == "") {
		native = projection.NativeThreadID
	}
	projection.NativeThreadID = native
	edges := mailHeaderEdges(id, key, projection)
	seeds := []string{key}
	if previousKey != "" {
		seeds = append(seeds, previousKey)
	}
	for _, edge := range edges {
		seeds = append(seeds, edge.Left, edge.Right)
	}
	nodes, oldEdges, members, incomplete, err := loadMailGraph(ctx, transaction, message.Source, seeds, limits, preview)
	if err != nil {
		return result, err
	}
	result.Incomplete = incomplete
	if !incomplete {
		oldEdges = slices.DeleteFunc(oldEdges, func(edge mailEdge) bool { return edge.Owner == id })
		oldEdges = append(oldEdges, edges...)
		members = slices.DeleteFunc(members, func(member mailMember) bool { return member.ID == id })
		members = append(members, mailMember{ID: id, Key: key, Native: native, ThreadID: message.ThreadID})
		if len(oldEdges) > limits.Edges || len(members) > limits.Messages {
			result.Incomplete = true
		}
	}
	components := []mailComponent{}
	var history []mailHistory
	if !result.Incomplete {
		components = groupMailGraph(nodes, oldEdges, members)
		history, result.Incomplete, err = planMailHistory(ctx, transaction, message.Source, nodes, components, limits.Nodes, preview)
		if err != nil {
			return result, err
		}
	}
	if !result.Incomplete {
		for _, component := range components {
			if slices.Contains(component.Keys, key) {
				result.ThreadID, result.Conflict = component.ThreadID, component.Conflict != ""
				if result.Conflict {
					result.ThreadID = native
				}
			}
		}
	} else {
		result.ThreadID = message.ThreadID
		if native != "" {
			result.ThreadID = native
		}
	}
	if !apply {
		if preview != nil && !result.Incomplete {
			if err := preview.remember(id, edges, members, components, history); err != nil {
				return result, err
			}
			preview.headers[id] = mailHeaders{MessageID: projection.MessageID, RawRef: projection.RawRef, InReplyTo: projection.InReplyTo, References: projection.References}
		}
		return result, nil
	}
	factKey := key
	if result.Incomplete && previousKey != "" {
		factKey = previousKey
	}
	if err := persistMailFacts(ctx, transaction, message, factKey, projection, edges, result.Incomplete); err != nil {
		return result, err
	}
	if result.Incomplete {
		if _, err := transaction.Exec(ctx, `update messages set thread_id=$2 where id=$1`, id, result.ThreadID); err != nil {
			return result, err
		}
	} else {
		if err := persistMailComponents(ctx, transaction, message.Source, components, history); err != nil {
			return result, err
		}
	}
	if workKey != "" && !result.Incomplete {
		if _, err := transaction.Exec(ctx, `insert into mail_rebuild_progress(source,work_key) values($1,$2) on conflict do nothing`, message.Source, workKey); err != nil {
			return result, err
		}
	}
	return result, transaction.Commit(ctx)
}

func mailHeaderEdges(owner int64, key string, projection MailProjection) []mailEdge {
	edges := []mailEdge{}
	previous := ""
	for _, reference := range projection.References {
		node := "rfc:" + reference
		if previous != "" && previous != node {
			edges = append(edges, mailEdge{owner, previous, node})
		}
		previous = node
	}
	if previous != "" && previous != key {
		edges = append(edges, mailEdge{owner, key, previous})
	}
	for _, parent := range projection.InReplyTo {
		if node := "rfc:" + parent; node != key {
			edges = append(edges, mailEdge{owner, key, node})
		}
	}
	return edges
}

func loadMailGraph(ctx context.Context, transaction pgx.Tx, source string, seeds []string, limits MailLimits, preview *MailPreview) (map[string]mailNode, []mailEdge, []mailMember, bool, error) {
	nodes := make(map[string]mailNode)
	frontier := []string{}
	add := func(key string) {
		if _, exists := nodes[key]; !exists {
			nodes[key] = mailNode{Key: key}
			frontier = append(frontier, key)
		}
	}
	for _, key := range seeds {
		add(key)
	}
	edges := []mailEdge{}
	seenEdges := make(map[mailEdge]bool)
	for len(frontier) > 0 {
		if len(nodes) > limits.Nodes {
			return nodes, edges, nil, true, nil
		}
		current := frontier
		frontier = nil
		if preview != nil {
			for _, key := range current {
				for edge := range preview.adjacent[key] {
					if !seenEdges[edge] {
						seenEdges[edge] = true
						edges = append(edges, edge)
						add(edge.Left)
						add(edge.Right)
					}
				}
			}
			if len(edges) > limits.Edges || len(nodes) > limits.Nodes {
				return nodes, edges, nil, true, nil
			}
		}
		rows, err := transaction.Query(ctx, `select owner_id,left_node,right_node from mail_thread_edges
			where source=$1 and (left_node=any($2) or right_node=any($2)) limit $3`, source, current, limits.Edges+1)
		if err != nil {
			return nil, nil, nil, false, err
		}
		for rows.Next() {
			var edge mailEdge
			if err := rows.Scan(&edge.Owner, &edge.Left, &edge.Right); err != nil {
				rows.Close()
				return nil, nil, nil, false, err
			}
			if preview != nil {
				if _, replaced := preview.edges[edge.Owner]; replaced {
					continue
				}
			}
			if !seenEdges[edge] {
				seenEdges[edge] = true
				edges = append(edges, edge)
				add(edge.Left)
				add(edge.Right)
			}
			if len(edges) > limits.Edges || len(nodes) > limits.Nodes {
				rows.Close()
				return nodes, edges, nil, true, nil
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, nil, nil, false, err
		}
	}
	keys := make([]string, 0, len(nodes))
	for key := range nodes {
		keys = append(keys, key)
	}
	rows, err := transaction.Query(ctx, `select node_key,thread_id,conflict_key from mail_thread_nodes where source=$1 and node_key=any($2)`, source, keys)
	if err != nil {
		return nil, nil, nil, false, err
	}
	for rows.Next() {
		var node mailNode
		if err := rows.Scan(&node.Key, &node.ThreadID, &node.Conflict); err != nil {
			rows.Close()
			return nil, nil, nil, false, err
		}
		nodes[node.Key] = node
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, nil, false, err
	}
	if preview != nil {
		for key := range nodes {
			if node, exists := preview.nodes[key]; exists {
				nodes[key] = node
			}
		}
	}
	rows, err = transaction.Query(ctx, `select d.message_id,d.node_key,d.native_thread_id,m.thread_id from mail_details d join messages m on m.id=d.message_id where d.source=$1 and d.node_key=any($2) limit $3`, source, keys, limits.Messages+1)
	if err != nil {
		return nil, nil, nil, false, err
	}
	defer rows.Close()
	members := []mailMember{}
	for rows.Next() {
		var member mailMember
		if err := rows.Scan(&member.ID, &member.Key, &member.Native, &member.ThreadID); err != nil {
			return nil, nil, nil, false, err
		}
		members = append(members, member)
	}
	if preview != nil {
		members = slices.DeleteFunc(members, func(member mailMember) bool { _, exists := preview.members[member.ID]; return exists })
		for key := range nodes {
			for _, member := range preview.byNode[key] {
				members = append(members, member)
			}
		}
	}
	return nodes, edges, members, len(members) > limits.Messages, rows.Err()
}

func groupMailGraph(nodes map[string]mailNode, edges []mailEdge, members []mailMember) []mailComponent {
	adjacent := make(map[string][]string)
	for _, edge := range edges {
		adjacent[edge.Left] = append(adjacent[edge.Left], edge.Right)
		adjacent[edge.Right] = append(adjacent[edge.Right], edge.Left)
	}
	anchors := make(map[string][]string)
	for _, member := range members {
		if member.Native != "" {
			anchors[member.Key] = append(anchors[member.Key], member.Native)
		}
	}
	visited := make(map[string]bool)
	components := []mailComponent{}
	for start := range nodes {
		if visited[start] {
			continue
		}
		component := mailComponent{}
		queue := []string{start}
		visited[start] = true
		native := make(map[string]bool)
		for len(queue) > 0 {
			key := queue[0]
			queue = queue[1:]
			component.Keys = append(component.Keys, key)
			for _, anchor := range anchors[key] {
				native[anchor] = true
			}
			for _, neighbor := range adjacent[key] {
				if !visited[neighbor] {
					visited[neighbor] = true
					queue = append(queue, neighbor)
				}
			}
		}
		slices.Sort(component.Keys)
		switch len(native) {
		case 0:
			component.ThreadID = mailDerivedID(component.Keys[0])
		case 1:
			for anchor := range native {
				component.ThreadID = anchor
			}
		default:
			component.Conflict = "conflict:" + mailDerivedID(component.Keys[0])
		}
		components = append(components, component)
	}
	return components
}

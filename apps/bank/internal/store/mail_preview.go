package store

import (
	"context"
	"fmt"
)

type MailPreview struct {
	nodes         map[string]mailNode
	members       map[int64]mailMember
	edges         map[int64][]mailEdge
	history       map[string][]string
	adjacent      map[string]map[mailEdge]bool
	byNode        map[string]map[int64]mailMember
	historyByNode map[string]map[string]bool
}

func (s *Store) PreviewMail(ctx context.Context, id int64, projection MailProjection, preview *MailPreview) (MailProjectionResult, error) {
	if preview.nodes == nil {
		preview.nodes = make(map[string]mailNode)
		preview.members = make(map[int64]mailMember)
		preview.edges = make(map[int64][]mailEdge)
		preview.history = make(map[string][]string)
		preview.adjacent = make(map[string]map[mailEdge]bool)
		preview.byNode = make(map[string]map[int64]mailMember)
		preview.historyByNode = make(map[string]map[string]bool)
	}
	return s.projectMail(ctx, id, projection, false, "", preview)
}

func (preview *MailPreview) remember(id int64, edges []mailEdge, members []mailMember, components []mailComponent, history []mailHistory) error {
	for _, edge := range preview.edges[id] {
		delete(preview.adjacent[edge.Left], edge)
		delete(preview.adjacent[edge.Right], edge)
	}
	preview.edges[id] = edges
	for _, edge := range edges {
		for _, key := range []string{edge.Left, edge.Right} {
			if preview.adjacent[key] == nil {
				preview.adjacent[key] = make(map[mailEdge]bool)
			}
			preview.adjacent[key][edge] = true
		}
	}
	for _, member := range members {
		if previous, exists := preview.members[member.ID]; exists {
			delete(preview.byNode[previous.Key], member.ID)
		}
		preview.members[member.ID] = member
		if preview.byNode[member.Key] == nil {
			preview.byNode[member.Key] = make(map[int64]mailMember)
		}
		preview.byNode[member.Key][member.ID] = member
	}
	for _, component := range components {
		for _, key := range component.Keys {
			preview.nodes[key] = mailNode{Key: key, ThreadID: component.ThreadID, Conflict: component.Conflict}
		}
	}
	for _, record := range history {
		for _, key := range preview.history[record.Key] {
			delete(preview.historyByNode[key], record.Key)
		}
		preview.history[record.Key] = record.Nodes
		for _, key := range record.Nodes {
			if preview.historyByNode[key] == nil {
				preview.historyByNode[key] = make(map[string]bool)
			}
			preview.historyByNode[key][record.Key] = true
		}
	}
	references := 0
	for _, edges := range preview.edges {
		references += len(edges)
	}
	for _, keys := range preview.history {
		references += len(keys)
	}
	if len(preview.nodes) > 100000 || len(preview.members) > 100000 || references > 1000000 {
		return fmt.Errorf("read-only mail preview exceeds its 100000-node/message or 1000000-reference workspace limit")
	}
	return nil
}

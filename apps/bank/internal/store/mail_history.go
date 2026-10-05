package store

import (
	"context"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
)

type mailHistory struct {
	Key   string
	Nodes []string
}

func planMailHistory(ctx context.Context, transaction pgx.Tx, source string, nodes map[string]mailNode, components []mailComponent, limit int, preview *MailPreview) ([]mailHistory, bool, error) {
	keys := make([]string, 0, len(nodes))
	for key := range nodes {
		keys = append(keys, key)
	}
	rows, err := transaction.Query(ctx, `select conflict_key,case when cardinality(node_keys)<=$3 then node_keys else '{}' end,cardinality(node_keys)
		from mail_thread_conflicts where source=$1 and node_keys && $2 limit $4`, source, keys, limit, limit+1)
	if err != nil {
		return nil, false, err
	}
	history := make(map[string][]string)
	used := 0
	for rows.Next() {
		var record mailHistory
		var count int
		if err := rows.Scan(&record.Key, &record.Nodes, &count); err != nil {
			rows.Close()
			return nil, false, err
		}
		used += count
		if used > limit {
			rows.Close()
			return nil, true, nil
		}
		history[record.Key] = record.Nodes
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, false, err
	}
	if preview != nil {
		for key := range nodes {
			for name := range preview.historyByNode[key] {
				history[name] = slices.Clone(preview.history[name])
			}
		}
	}
	for key, node := range nodes {
		if strings.HasPrefix(node.ThreadID, "mail:") {
			name := "history:" + node.ThreadID
			history[name] = append(history[name], key)
		}
	}
	byNode := make(map[string]int)
	for index, component := range components {
		for _, key := range component.Keys {
			byNode[key] = index
		}
		if component.Conflict != "" {
			history[component.Conflict] = append(history[component.Conflict], component.Keys...)
		}
	}
	result := make([]mailHistory, 0, len(history))
	used = 0
	for name, keys := range history {
		component := -1
		for _, key := range keys {
			index, exists := byNode[key]
			if !exists || (component >= 0 && index != component) {
				component = -2
				break
			}
			component = index
		}
		if component >= 0 {
			keys = append(keys, components[component].Keys...)
		}
		slices.Sort(keys)
		keys = slices.Compact(keys)
		used += len(keys)
		if used > limit {
			return nil, true, nil
		}
		result = append(result, mailHistory{Key: name, Nodes: keys})
	}
	return result, false, nil
}

func persistMailHistory(ctx context.Context, transaction pgx.Tx, source string, history []mailHistory) error {
	batch := &pgx.Batch{}
	keys := make([]string, 0, len(history))
	for _, record := range history {
		keys = append(keys, record.Key)
		batch.Queue(`insert into mail_thread_conflicts(source,conflict_key,node_keys) values($1,$2,$3)
			on conflict(source,conflict_key) do update set node_keys=excluded.node_keys
			where mail_thread_conflicts.node_keys is distinct from excluded.node_keys`, source, record.Key, record.Nodes)
	}
	if err := transaction.SendBatch(ctx, batch).Close(); err != nil {
		return err
	}
	rows, err := transaction.Query(ctx, `select c.conflict_key,case when count(distinct n.thread_id)=1 and bool_and(n.conflict_key='') then min(n.thread_id) else '' end
		from mail_thread_conflicts c join mail_thread_nodes n on n.source=c.source and n.node_key=any(c.node_keys)
		where c.source=$1 and c.conflict_key=any($2) group by c.conflict_key`, source, keys)
	if err != nil {
		return err
	}
	type destination struct{ Key, Thread string }
	destinations, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (destination, error) {
		var result destination
		err := row.Scan(&result.Key, &result.Thread)
		return result, err
	})
	if err != nil {
		return err
	}
	batch = &pgx.Batch{}
	for _, destination := range destinations {
		conflict := destination.Key
		if destination.Thread != "" {
			conflict = ""
		}
		oldID := ""
		if strings.HasPrefix(destination.Key, "history:") {
			oldID = strings.TrimPrefix(destination.Key, "history:")
		}
		batch.Queue(`update mail_thread_aliases a set current_id=nullif($3,''),conflict_key=nullif($4,'')
			where a.source=$1 and (a.conflict_key=$2 or a.old_id=$5)
			and (a.current_id,a.conflict_key) is distinct from (nullif($3,''),nullif($4,''))
			and not exists(select 1 from mail_details where source=$1 and native_thread_id=a.old_id)`, source, destination.Key, destination.Thread, conflict, oldID)
	}
	return transaction.SendBatch(ctx, batch).Close()
}

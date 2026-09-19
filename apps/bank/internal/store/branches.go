package store

import "context"

type Branch struct {
	Messages   []MessageDetail `json:"messages"`
	Incomplete bool            `json:"incomplete"`
}

// MessageBranch reads only the ancestors of the selected answer, in reply order.
// The path guard stops cycles; the depth limit bounds damaged or huge exports.
func (s *Store) MessageBranch(ctx context.Context, id int64) (Branch, error) {
	out := Branch{Messages: []MessageDetail{}}
	rows, err := s.pool.Query(ctx, `with recursive chain as (
 select id,source,thread_id,parent_external_id,1 depth,array[id] path from messages where id=$1
 union all
 select m.id,m.source,m.thread_id,m.parent_external_id,c.depth+1,c.path||m.id
 from chain c join messages m on m.source=c.source and m.thread_id=c.thread_id and m.external_id=c.parent_external_id
 where c.depth<1000 and not m.id=any(c.path)
 ) select `+messageColumns+` from messages m join chain c on c.id=m.id order by c.depth desc`, id)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var m MessageDetail
		if err := m.scanFull(rows); err != nil {
			rows.Close()
			return out, err
		}
		out.Messages = append(out.Messages, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	if len(out.Messages) == 0 {
		return out, ErrNotFound
	}
	out.Incomplete = out.Messages[0].ParentExternalID != ""
	return out, s.loadAttachments(ctx, out.Messages)
}

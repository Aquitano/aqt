package store

import "context"

func (s *Store) MailRebuildDone(ctx context.Context, source, key string, id int64) (bool, error) {
	var done bool
	err := s.pool.QueryRow(ctx, `select exists(select 1 from mail_rebuild_progress where source=$1 and work_key=$2)
		and not exists(select 1 from mail_details where message_id=$3 and incomplete)`, source, key, id).Scan(&done)
	return done, err
}

package store

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
)

type MailThreadConflictError struct {
	Code           string   `json:"code"`
	Source         string   `json:"source"`
	ConflictKey    string   `json:"conflict_key"`
	Choices        []string `json:"choices"`
	UnanchoredPath string   `json:"unanchored_path"`
}

func (conflict *MailThreadConflictError) Error() string {
	return fmt.Sprintf("mail conversation split into current threads (%s); use bank thread <id> --current --source %s or bank mail conflict %s --source %s for unanchored messages", strings.Join(conflict.Choices, ", "), conflict.Source, conflict.ConflictKey, conflict.Source)
}

func (s *Store) resolveMailThread(ctx context.Context, source, threadID string) (string, error) {
	var destination, conflict string
	err := s.pool.QueryRow(ctx, `select coalesce(current_id,''),coalesce(conflict_key,'') from mail_thread_aliases
		where source=$1 and old_id=$2 and not exists(select 1 from mail_details where source=$1 and native_thread_id=$2)`, source, threadID).Scan(&destination, &conflict)
	if errors.Is(err, pgx.ErrNoRows) {
		return threadID, nil
	}
	if err != nil {
		return "", err
	}
	if conflict == "" {
		return destination, nil
	}
	rows, err := s.pool.Query(ctx, `select distinct m.thread_id from mail_thread_conflicts c join mail_details d on d.source=c.source and d.node_key=any(c.node_keys)
		join messages m on m.id=d.message_id where c.source=$1 and c.conflict_key=$2 and m.thread_id<>'' order by m.thread_id`, source, conflict)
	if err != nil {
		return "", err
	}
	choices, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return "", err
	}
	if choices == nil {
		choices = []string{}
	}
	return "", &MailThreadConflictError{Code: "mail_thread_conflict", Source: source, ConflictKey: conflict, Choices: choices, UnanchoredPath: "/v1/mail-conflicts/" + url.PathEscape(conflict) + "?source=" + url.QueryEscape(source)}
}

func (s *Store) MailConflictMessages(ctx context.Context, source, key string, before int64, limit int) (Thread, error) {
	result := Thread{ThreadID: key, Source: source, Messages: []MessageDetail{}}
	if source == "" || key == "" || before < 0 || limit < 0 || limit > MaxThreadMessages {
		return result, fmt.Errorf("source, conflict key and valid page bounds are required")
	}
	if limit == 0 {
		limit = 100
	}
	var exists bool
	if err := s.pool.QueryRow(ctx, `select exists(select 1 from mail_thread_conflicts where source=$1 and conflict_key=$2)`, source, key).Scan(&exists); err != nil {
		return result, err
	}
	if !exists {
		return result, ErrNotFound
	}
	query := `select ` + messageColumns + ` from messages m join mail_details d on d.message_id=m.id
		join mail_thread_conflicts c on c.source=d.source and d.node_key=any(c.node_keys)
		where c.source=$1 and c.conflict_key=$2 and m.thread_id=''`
	args := []any{source, key, limit + 1}
	if before != 0 {
		var anchor Message
		if err := anchor.scanFull(s.pool.QueryRow(ctx, query+` and m.id=$3`, source, key, before)); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return result, ErrNotFound
			}
			return result, err
		}
		query += ` and (m.sent_at,m.id)<($4,$5)`
		args = append(args, anchor.SentAt, anchor.ID)
	}
	rows, err := s.pool.Query(ctx, query+` order by m.sent_at desc,m.id desc limit $3`, args...)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var message MessageDetail
		if err := message.scanFull(rows); err != nil {
			rows.Close()
			return result, err
		}
		result.Messages = append(result.Messages, message)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	result.HasBefore = len(result.Messages) > limit
	if result.HasBefore {
		result.Messages = result.Messages[:limit]
	}
	result.Truncated = result.HasBefore
	slices.Reverse(result.Messages)
	return result, s.loadAttachments(ctx, result.Messages)
}

package store

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/page"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
)

type Thread struct {
	ThreadID  string          `json:"thread_id"`
	Source    string          `json:"source"`
	Messages  []MessageDetail `json:"messages"`
	Truncated bool            `json:"truncated" doc:"The page is not the whole conversation: has_before or has_after is set."`
	HasBefore bool            `json:"has_before" doc:"Older messages exist; pass the first message's ref as before."`
	HasAfter  bool            `json:"has_after" doc:"Newer messages exist; pass the last message's ref as after."`
}

// Cursors name messages in this thread. Pages use (sort_at, id), so messages
// with equal timestamps are neither repeated nor skipped, and undated
// messages come first.
type ThreadOpts struct {
	Limit   int
	Before  ref.Message
	After   ref.Message
	Around  ref.Message
	Latest  bool
	Current bool
}

func (o ThreadOpts) Validate() error {
	if err := page.Check(page.Limit(o.Limit), 0); err != nil {
		return err
	}
	positions := 0
	for _, cursor := range []ref.Message{o.Before, o.After, o.Around} {
		if !cursor.IsZero() {
			positions++
		}
	}
	if o.Latest {
		positions++
	}
	if positions > 1 {
		return fail.Invalidf("use only one of before, after, around, or latest")
	}
	return nil
}

type AmbiguousThreadError struct {
	ThreadID string
	Sources  []string
}

func (e *AmbiguousThreadError) Error() string {
	return fmt.Sprintf("thread %q exists in %d sources (%s); pass --source to pick one", e.ThreadID, len(e.Sources), strings.Join(e.Sources, ", "))
}

func (s *Store) threadSources(ctx context.Context, threadID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `select source from messages where thread_id = $1 union select source from mail_thread_aliases where old_id=$1 order by source`, threadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// GetThread preserves the original oldest-first read for internal callers.
func (s *Store) GetThread(ctx context.Context, source, threadID string, limit int) (Thread, error) {
	return s.GetThreadPage(ctx, source, threadID, ThreadOpts{Limit: limit})
}

func (s *Store) GetThreadPage(ctx context.Context, source, threadID string, o ThreadOpts) (Thread, error) {
	out := Thread{ThreadID: cleanText(threadID), Source: source, Messages: []MessageDetail{}}
	if err := o.Validate(); err != nil {
		return out, err
	}
	if out.ThreadID == "" {
		return out, fail.Invalidf("thread id must not be empty")
	}
	o.Limit = page.Limit(o.Limit)
	if source == "" {
		sources, err := s.threadSources(ctx, out.ThreadID)
		if err != nil {
			return out, err
		}
		switch len(sources) {
		case 0:
			return out, ErrNotFound
		case 1:
			out.Source = sources[0]
		default:
			return out, &AmbiguousThreadError{ThreadID: threadID, Sources: sources}
		}
	}
	if !o.Current {
		resolved, resolveErr := s.resolveMailThread(ctx, out.Source, out.ThreadID)
		if resolveErr != nil {
			return out, resolveErr
		}
		out.ThreadID = resolved
	}
	var anchor Message
	cursor := cmp.Or(o.Before, o.After, o.Around)
	if !cursor.IsZero() {
		err := anchor.scanFull(s.pool.QueryRow(ctx, `select `+messageColumns+` from messages m where m.ref = $1 and m.source = $2 and m.thread_id = $3`, cursor.String(), out.Source, out.ThreadID))
		if errors.Is(err, pgx.ErrNoRows) {
			return out, ErrNotFound
		}
		if err != nil {
			return out, err
		}
	}
	var err error
	switch {
	case !o.Around.IsZero():
		older, e := s.threadRows(ctx, out, anchor, "<", true, o.Limit/2)
		if e != nil {
			return out, e
		}
		newer, e := s.threadRows(ctx, out, anchor, ">=", false, o.Limit-len(older))
		if e != nil {
			return out, e
		}
		out.Messages = append(out.Messages, older...)
		out.Messages = append(out.Messages, newer...)
	case !o.Before.IsZero():
		out.Messages, err = s.threadRows(ctx, out, anchor, "<", true, o.Limit)
	case !o.After.IsZero():
		out.Messages, err = s.threadRows(ctx, out, anchor, ">", false, o.Limit)
	default:
		out.Messages, err = s.threadRows(ctx, out, anchor, "", o.Latest, o.Limit)
	}
	if err != nil {
		return out, err
	}
	if len(out.Messages) == 0 {
		if cursor.IsZero() {
			return out, ErrNotFound
		}
		out.HasBefore, out.HasAfter = !o.After.IsZero(), !o.Before.IsZero()
	} else {
		first, last := out.Messages[0], out.Messages[len(out.Messages)-1]
		err = s.pool.QueryRow(ctx, `select
			exists(select 1 from messages where source=$1 and thread_id=$2 and (sort_at,id)<((select sort_at from messages where id=$3),$3)),
			exists(select 1 from messages where source=$1 and thread_id=$2 and (sort_at,id)>((select sort_at from messages where id=$4),$4))`,
			out.Source, out.ThreadID, first.ID, last.ID).Scan(&out.HasBefore, &out.HasAfter)
		if err != nil {
			return out, err
		}
		if err := s.loadAttachments(ctx, out.Messages); err != nil {
			return out, err
		}
	}
	out.Truncated = out.HasBefore || out.HasAfter
	return out, nil
}

func (s *Store) threadRows(ctx context.Context, thread Thread, anchor Message, op string, descending bool, limit int) ([]MessageDetail, error) {
	out := []MessageDetail{}
	if limit == 0 {
		return out, nil
	}
	query := `select ` + messageColumns + ` from messages m where m.source=$1 and m.thread_id=$2`
	args := []any{thread.Source, thread.ThreadID, limit}
	if op != "" {
		query += ` and (m.sort_at,m.id) ` + op + ` ((select sort_at from messages where id=$4),$4)`
		args = append(args, anchor.ID)
	}
	order := "asc"
	if descending {
		order = "desc"
	}
	query += ` order by m.sort_at ` + order + `, m.id ` + order + ` limit $3`
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var m MessageDetail
		if err := m.scanFull(rows); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	if descending {
		slices.Reverse(out)
	}
	return out, rows.Err()
}

// Fetch attachments once per page, rather than once per message.
func (s *Store) loadAttachments(ctx context.Context, messages []MessageDetail) error {
	if len(messages) == 0 {
		return nil
	}
	ids := make([]int64, len(messages))
	byID := make(map[int64]int, len(messages))
	for i, m := range messages {
		ids[i], byID[m.ID] = m.ID, i
	}
	rows, err := s.pool.Query(ctx, `select a.position, a.message_id, a.filename, a.mime_type, c.size_bytes, c.blake3,
		coalesce(t.status, 'pending'), coalesce(t.chars, 0)
		from attachments a join contents c on c.id = a.content_id left join texts t on t.content_id = a.content_id
		where a.message_id=any($1) order by a.message_id, a.position`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var a Attachment
		if err := rows.Scan(&a.Position, &a.MessageID, &a.Filename, &a.MimeType, &a.SizeBytes, &a.BLAKE3, &a.TextStatus, &a.TextChars); err != nil {
			return err
		}
		i := byID[a.MessageID]
		messages[i].Attachments = append(messages[i].Attachments, a)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	if err := s.loadMailboxes(ctx, messages); err != nil {
		return err
	}
	return s.loadMailProvenance(ctx, messages)
}

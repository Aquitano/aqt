// Package store owns the Postgres schema and all queries. Migrations are
// embedded and applied automatically on Open, so the binary is self-contained.
package store

import (
	"context"
	"embed"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrations embed.FS

type Store struct {
	pool *pgxpool.Pool
}

type Message struct {
	ID         int64     `json:"id"`
	Source     string    `json:"source"`
	ExternalID string    `json:"external_id,omitempty"`
	ThreadID   string    `json:"thread_id,omitempty"`
	Sender     string    `json:"sender"`
	Recipients []string  `json:"recipients,omitempty"`
	Subject    string    `json:"subject,omitempty"`
	Body       string    `json:"body"`
	SentAt     time.Time `json:"sent_at"`
	RawRef     string    `json:"raw_ref,omitempty"`
	Score      float64   `json:"score,omitempty"`
}

type Attachment struct {
	ID        int64  `json:"id"`
	MessageID int64  `json:"message_id"`
	Filename  string `json:"filename"`
	MimeType  string `json:"mime_type,omitempty"`
	SizeBytes int64  `json:"size_bytes"`
	SHA256    string `json:"sha256"`
}

// MessageDetail is one message plus its attachments — the shape `bank show
// --json` prints and GET /v1/messages/{id} returns, shared so both emit one format.
type MessageDetail struct {
	Message
	Attachments []Attachment `json:"attachments,omitempty"`
}

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	s := &Store{pool: pool}
	if err := s.migrate(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return s, nil
}

func (s *Store) Close() { s.pool.Close() }

func (s *Store) migrate(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx,
		`create table if not exists schema_migrations (filename text primary key, applied_at timestamptz not null default now())`); err != nil {
		return err
	}
	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	for _, name := range names {
		var applied bool
		if err := s.pool.QueryRow(ctx,
			`select exists (select 1 from schema_migrations where filename = $1)`, name).Scan(&applied); err != nil {
			return err
		}
		if applied {
			continue
		}
		sql, err := migrations.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("%s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, `insert into schema_migrations (filename) values ($1)`, name); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("%s: %w", name, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
	}
	return nil
}

// InsertMessage is idempotent via the (source, external_id) unique constraint.
// Returns (0, nil) when the message was already present.
func (s *Store) InsertMessage(ctx context.Context, m Message) (int64, error) {
	if m.Recipients == nil {
		m.Recipients = []string{}
	}
	var id int64
	err := s.pool.QueryRow(ctx, `
		insert into messages (source, external_id, thread_id, sender, recipients, subject, body, sent_at, raw_ref)
		values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		on conflict (source, external_id) do nothing
		returning id`,
		m.Source, m.ExternalID, m.ThreadID, m.Sender, m.Recipients, m.Subject, m.Body, m.SentAt, m.RawRef,
	).Scan(&id)
	if err == pgx.ErrNoRows {
		return 0, nil
	}
	return id, err
}

func (s *Store) InsertAttachment(ctx context.Context, a Attachment) error {
	_, err := s.pool.Exec(ctx, `
		insert into attachments (message_id, filename, mime_type, size_bytes, sha256)
		values ($1, $2, $3, $4, $5)`,
		a.MessageID, a.Filename, a.MimeType, a.SizeBytes, a.SHA256)
	return err
}

// HasMessage lets importers skip expensive fetches for already-archived mail.
func (s *Store) HasMessage(ctx context.Context, source, externalID string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx,
		`select exists (select 1 from messages where source = $1 and external_id = $2)`,
		source, externalID).Scan(&exists)
	return exists, err
}

// GetSyncState returns the stored JSON state for a source, or nil if none.
func (s *Store) GetSyncState(ctx context.Context, source string) ([]byte, error) {
	var state []byte
	err := s.pool.QueryRow(ctx,
		`select state from sync_state where source = $1`, source).Scan(&state)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return state, err
}

func (s *Store) SetSyncState(ctx context.Context, source string, state []byte) error {
	_, err := s.pool.Exec(ctx, `
		insert into sync_state (source, state) values ($1, $2)
		on conflict (source) do update set state = excluded.state, updated_at = now()`,
		source, state)
	return err
}

type SearchOpts struct {
	Source string
	From   string
	Since  time.Time
	Until  time.Time
	Fuzzy  int
	Limit  int
}

// Search runs a BM25-ranked query over subject, body and sender via pg_search.
// Fuzzy is the Levenshtein distance for typo tolerance (0 = exact tokens).
func (s *Store) Search(ctx context.Context, query string, o SearchOpts) ([]Message, error) {
	sql := `
		select m.id, m.source, m.thread_id, m.sender, m.subject, m.body, m.sent_at, paradedb.score(m.id)
		from messages m
		where m.id @@@ paradedb.boolean(should => array[
			paradedb.match('subject', $1, distance => $2),
			paradedb.match('body', $1, distance => $2),
			paradedb.match('sender', $1, distance => $2)
		])`
	args := []any{query, o.Fuzzy}
	next := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}
	if o.Source != "" {
		sql += " and m.source = " + next(o.Source)
	}
	if o.From != "" {
		sql += " and m.sender ilike " + next("%"+o.From+"%")
	}
	if !o.Since.IsZero() {
		sql += " and m.sent_at >= " + next(o.Since)
	}
	if !o.Until.IsZero() {
		sql += " and m.sent_at < " + next(o.Until)
	}
	sql += " order by paradedb.score(m.id) desc, m.sent_at desc limit " + next(o.Limit)

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Message
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.Source, &m.ThreadID, &m.Sender, &m.Subject, &m.Body, &m.SentAt, &m.Score); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) GetMessage(ctx context.Context, id int64) (Message, []Attachment, error) {
	var m Message
	err := s.pool.QueryRow(ctx, `
		select id, source, external_id, thread_id, sender, recipients, subject, body, sent_at, raw_ref
		from messages where id = $1`, id,
	).Scan(&m.ID, &m.Source, &m.ExternalID, &m.ThreadID, &m.Sender, &m.Recipients, &m.Subject, &m.Body, &m.SentAt, &m.RawRef)
	if err != nil {
		return m, nil, err
	}
	rows, err := s.pool.Query(ctx, `
		select id, message_id, filename, mime_type, size_bytes, sha256
		from attachments where message_id = $1 order by id`, id)
	if err != nil {
		return m, nil, err
	}
	defer rows.Close()
	var atts []Attachment
	for rows.Next() {
		var a Attachment
		if err := rows.Scan(&a.ID, &a.MessageID, &a.Filename, &a.MimeType, &a.SizeBytes, &a.SHA256); err != nil {
			return m, nil, err
		}
		atts = append(atts, a)
	}
	return m, atts, rows.Err()
}

type SourceStats struct {
	Source   string    `json:"source"`
	Messages int64     `json:"messages"`
	Earliest time.Time `json:"earliest"`
	Latest   time.Time `json:"latest"`
}

func (s *Store) Stats(ctx context.Context) ([]SourceStats, error) {
	rows, err := s.pool.Query(ctx, `
		select source, count(*), min(sent_at), max(sent_at)
		from messages group by source order by source`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SourceStats
	for rows.Next() {
		var st SourceStats
		if err := rows.Scan(&st.Source, &st.Messages, &st.Earliest, &st.Latest); err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

// Package store owns the Postgres schema and all queries. Migrations are
// embedded and applied automatically on Open, so the binary is self-contained.
package store

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrations embed.FS

// migrationLock is an arbitrary but fixed advisory-lock key ("bankmig"). Every
// process takes it before touching schema_migrations, so two commands starting
// against an unmigrated database cannot both run the same DDL.
const migrationLock int64 = 0x62616e6b6d6967

type Store struct {
	pool *pgxpool.Pool
}

type Message struct {
	ID         int64     `json:"id"`
	Source     string    `json:"source"`
	ExternalID string    `json:"external_id,omitempty"`
	MessageID  string    `json:"message_id,omitempty"` // RFC 822 Message-ID for mail sources
	ThreadID   string    `json:"thread_id,omitempty"`
	Sender     string    `json:"sender"`
	Recipients []string  `json:"recipients,omitempty"`
	Subject    string    `json:"subject,omitempty"`
	Body       string    `json:"body"`
	SentAt     time.Time `json:"sent_at"`
	RawRef     string    `json:"raw_ref,omitempty"`
	Score      float64   `json:"score,omitempty"`
	// Snippet is a bounded window of the body around the match, plain text so
	// it is safe to print anywhere. Empty when nothing matched in the body.
	Snippet string `json:"snippet,omitempty"`
	// AttachmentSnippet is the same window cut from the text extracted out of
	// the message's attachments, so a hit inside a PDF says which words
	// matched instead of looking like a body match with no visible reason.
	//
	// Unlike Snippet there is no local fallback: the extracted text is not
	// selected — it can be megabytes per row — so a fuzzy-only attachment
	// match leaves this empty rather than showing an unrelated head of the
	// document.
	AttachmentSnippet string `json:"attachment_snippet,omitempty"`
}

type Attachment struct {
	ID        int64  `json:"id"`
	MessageID int64  `json:"message_id"`
	Filename  string `json:"filename"`
	MimeType  string `json:"mime_type,omitempty"`
	SizeBytes int64  `json:"size_bytes"`
	SHA256    string `json:"sha256"`
	// TextStatus is the extraction outcome for this content (StatusPending
	// when nothing has run), and TextChars how much text it yielded. Shown by
	// `bank show` so it is obvious whether a document is searchable inside.
	TextStatus string `json:"text_status,omitempty"`
	TextChars  int    `json:"text_chars,omitempty"`
}

// MessageDetail is one message plus its attachments — the shape `bank show
// --json` prints and GET /v1/messages/{id} returns, shared so both emit one format.
type MessageDetail struct {
	Message
	Attachments []Attachment `json:"attachments,omitempty"`
}

// ErrNotFound is returned when a lookup found no row, so callers can tell an
// absent message from a broken database.
var ErrNotFound = errors.New("not found")

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

// migrate applies pending migrations under a session-level advisory lock, so
// concurrent startups serialize instead of racing check-then-apply. A failure
// releases the lock with the schema untouched: the migration runs in a
// transaction and is only recorded when its DDL committed.
func (s *Store) migrate(ctx context.Context) error {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `select pg_advisory_lock($1)`, migrationLock); err != nil {
		return err
	}
	defer conn.Exec(context.WithoutCancel(ctx), `select pg_advisory_unlock($1)`, migrationLock)

	if _, err := conn.Exec(ctx,
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
		if err := conn.QueryRow(ctx,
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
		tx, err := conn.Begin(ctx)
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
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	return nil
}

// InsertMessage is idempotent via the (source, external_id) unique constraint.
// Returns (0, nil) when the message was already present.
//
// The bare "on conflict do nothing" also swallows the partial unique index on
// (source, message_id), which is how mail imports dedup two copies of the same
// mail that arrived under different provider ids.
func (s *Store) InsertMessage(ctx context.Context, m Message) (int64, error) {
	m, err := m.clean()
	if err != nil {
		return 0, err
	}
	var id int64
	err = s.pool.QueryRow(ctx, `
		insert into messages (source, external_id, message_id, thread_id, sender, recipients, subject, body, sent_at, raw_ref)
		values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		on conflict do nothing
		returning id`,
		m.Source, m.ExternalID, m.MessageID, m.ThreadID, m.Sender, m.Recipients, m.Subject, m.Body, m.SentAt, m.RawRef,
	).Scan(&id)
	if err == pgx.ErrNoRows {
		return 0, nil
	}
	return id, err
}

// InsertMessageRethreading is InsertMessage for sources whose thread id,
// subject, and sent_at are derived, and so can change when the derivation is
// fixed: an already-stored message is re-keyed onto the incoming values
// instead of being left under the old ones. Everything else about the stored
// row is kept — a re-import is not an authority on a body that may since have
// been repaired.
//
// Like InsertMessage it returns (0, nil) for a message that was already
// present, re-keyed or not, so importers keep counting it as a duplicate
// rather than as new.
//
// Only (source, external_id) is treated as the conflict: a caller that also
// sets MessageID would hit the second unique index as a raw error rather than
// the silent skip InsertMessage gives it.
func (s *Store) InsertMessageRethreading(ctx context.Context, m Message) (int64, error) {
	m, err := m.clean()
	if err != nil {
		return 0, err
	}
	var id int64
	var inserted bool
	// The where clause keeps an unchanged re-import from rewriting every row,
	// at the cost of returning nothing for it — which is a duplicate either
	// way. xmax tells a fresh insert from a re-keyed conflict.
	err = s.pool.QueryRow(ctx, `
		insert into messages (source, external_id, message_id, thread_id, sender, recipients, subject, body, sent_at, raw_ref)
		values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		on conflict (source, external_id) do update
			set thread_id = excluded.thread_id, subject = excluded.subject, sent_at = excluded.sent_at
			where messages.thread_id is distinct from excluded.thread_id
			   or messages.subject is distinct from excluded.subject
			   or messages.sent_at is distinct from excluded.sent_at
		returning id, xmax = 0`,
		m.Source, m.ExternalID, m.MessageID, m.ThreadID, m.Sender, m.Recipients, m.Subject, m.Body, m.SentAt, m.RawRef,
	).Scan(&id, &inserted)
	if err == pgx.ErrNoRows {
		return 0, nil
	}
	if err != nil || !inserted {
		return 0, err
	}
	return id, nil
}

// clean normalizes every text field to what the columns accept and rejects a
// message that could not be identified.
func (m Message) clean() (Message, error) {
	m.ExternalID = cleanText(m.ExternalID)
	m.MessageID = cleanText(m.MessageID)
	if m.Source == "" || m.ExternalID == "" {
		return m, fmt.Errorf("message needs source (%q) and external_id (%q)", m.Source, m.ExternalID)
	}
	if m.Recipients == nil {
		m.Recipients = []string{}
	}
	m.Sender = cleanText(m.Sender)
	m.Subject = cleanText(m.Subject)
	m.Body = cleanText(m.Body)
	m.ThreadID = cleanText(m.ThreadID)
	for i, r := range m.Recipients {
		m.Recipients[i] = cleanText(r)
	}
	return m, nil
}

// cleanText makes a string safe for a Postgres text column: valid UTF-8
// (mislabeled legacy charsets are common in old email) and no NUL bytes.
// Identifiers get the same treatment as bodies — a Message-ID with a stray
// 0x00 would otherwise fail insertion and, on Gmail, wedge the whole sync.
func cleanText(s string) string {
	if utf8.ValidString(s) && !strings.ContainsRune(s, 0) {
		return s
	}
	s = strings.ToValidUTF8(s, "�")
	return strings.ReplaceAll(s, "\x00", "")
}

// FindMessageID returns the row id for (source, external_id), or 0 if absent.
func (s *Store) FindMessageID(ctx context.Context, source, externalID string) (int64, error) {
	var id int64
	err := s.pool.QueryRow(ctx,
		`select id from messages where source = $1 and external_id = $2`, source, cleanText(externalID)).Scan(&id)
	if err == pgx.ErrNoRows {
		return 0, nil
	}
	return id, err
}

// FindByEmailMessageID returns the row id of a mail already archived for the
// source under this RFC 822 Message-ID, regardless of which id scheme keyed
// it, or 0 if absent.
func (s *Store) FindByEmailMessageID(ctx context.Context, source, messageID string) (int64, error) {
	messageID = cleanText(messageID)
	if messageID == "" {
		return 0, nil
	}
	var id int64
	err := s.pool.QueryRow(ctx,
		`select id from messages where source = $1 and message_id = $2 order by id limit 1`,
		source, messageID).Scan(&id)
	if err == pgx.ErrNoRows {
		return 0, nil
	}
	return id, err
}

func (s *Store) MessageHasAttachments(ctx context.Context, messageID int64) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx,
		`select exists (select 1 from attachments where message_id = $1)`, messageID).Scan(&exists)
	return exists, err
}

// AttachmentKeys counts the attachments already stored for a message, keyed by
// content and filename. Re-importing a message whose blobs failed the first
// time uses this to add only what is missing.
func (s *Store) AttachmentKeys(ctx context.Context, messageID int64) (map[string]int, error) {
	rows, err := s.pool.Query(ctx,
		`select sha256, filename from attachments where message_id = $1`, messageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var sum, filename string
		if err := rows.Scan(&sum, &filename); err != nil {
			return nil, err
		}
		out[AttachmentKey(sum, filename)]++
	}
	return out, rows.Err()
}

// AttachmentKey identifies one attachment by content and name, the pair that
// makes re-import healing idempotent.
func AttachmentKey(sha256, filename string) string {
	return sha256 + "\x00" + cleanText(filename)
}

func (s *Store) InsertAttachment(ctx context.Context, a Attachment) error {
	_, err := s.pool.Exec(ctx, `
		insert into attachments (message_id, filename, mime_type, size_bytes, sha256)
		values ($1, $2, $3, $4, $5)`,
		a.MessageID, cleanText(a.Filename), cleanText(a.MimeType), a.SizeBytes, a.SHA256)
	return err
}

// HasMessage lets importers skip expensive fetches for already-archived mail.
func (s *Store) HasMessage(ctx context.Context, source, externalID string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx,
		`select exists (select 1 from messages where source = $1 and external_id = $2)`,
		source, cleanText(externalID)).Scan(&exists)
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

// MaxSearchLimit caps how many rows one search may return. Large enough for
// "give me everything about X", small enough that a typo can't ask Postgres
// for the whole archive.
const MaxSearchLimit = 500

// MaxFuzzyDistance is pg_search's supported Levenshtein range.
const MaxFuzzyDistance = 2

// MaxSearchOffset bounds how deep paging may go. Every offset re-ranks the
// whole match set before discarding the skipped rows, so page 500 costs what
// page 1 cost plus everything between. Twenty pages of 500 is far past the
// point where narrowing the query beats paging through it.
const MaxSearchOffset = 10000

type SearchOpts struct {
	Source string
	From   string
	To     string
	// Person is a contact name: the filter resolves through that contact's
	// aliases, so one query covers every source the person appears in.
	Person string
	Since  time.Time
	Until  time.Time
	Fuzzy  int
	Limit  int
	// Offset skips this many ranked results, so a query with more matches
	// than Limit is reachable past the first page.
	Offset int
}

// Validate rejects options that would otherwise return misleading empty
// results or a raw database error. Both the CLI and the HTTP handler call it,
// so local and remote modes fail the same way.
func (o SearchOpts) Validate() error {
	if o.Limit <= 0 {
		return fmt.Errorf("limit must be at least 1")
	}
	if o.Limit > MaxSearchLimit {
		return fmt.Errorf("limit must be at most %d", MaxSearchLimit)
	}
	if o.Fuzzy < 0 || o.Fuzzy > MaxFuzzyDistance {
		return fmt.Errorf("fuzzy must be between 0 and %d", MaxFuzzyDistance)
	}
	if o.Offset < 0 {
		return fmt.Errorf("offset must not be negative")
	}
	if o.Offset > MaxSearchOffset {
		return fmt.Errorf("offset must be at most %d; narrow the query instead of paging deeper", MaxSearchOffset)
	}
	if !o.Since.IsZero() && !o.Until.IsZero() && !o.Until.After(o.Since) {
		return fmt.Errorf("--until must be after --since")
	}
	return nil
}

// Search runs a BM25-ranked query over subject, body, sender and recipients
// via pg_search. Fuzzy is the Levenshtein distance for typo tolerance
// (0 = exact tokens).
func (s *Store) Search(ctx context.Context, query string, o SearchOpts) ([]Message, error) {
	if err := o.Validate(); err != nil {
		return nil, err
	}
	sql := `
		select m.id, m.source, m.thread_id, m.sender, m.subject, m.body, m.sent_at,
		       paradedb.score(m.id), coalesce(paradedb.snippet(m.body, '', '', %d), ''),
		       coalesce(paradedb.snippet(m.attachment_text, '', '', %d), '')
		from messages m
		where m.id @@@ paradedb.boolean(should => array[
			paradedb.match('subject', $1, distance => $2),
			paradedb.match('body', $1, distance => $2),
			paradedb.match('sender', $1, distance => $2),
			paradedb.match('recipients', $1, distance => $2),
			paradedb.match('attachment_text', $1, distance => $2)
		])`
	sql = fmt.Sprintf(sql, snippetChars, snippetChars)
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
	if o.To != "" {
		sql += " and exists (select 1 from unnest(m.recipients) r where r ilike " + next("%"+o.To+"%") + ")"
	}
	if o.Person != "" {
		c, err := s.GetContact(ctx, o.Person)
		if err != nil {
			if err == ErrNotFound {
				return nil, &ErrNoContact{Name: o.Person}
			}
			return nil, err
		}
		sql += " and" + aliasMatch(next(c.ID))
	}
	if !o.Since.IsZero() {
		sql += " and m.sent_at >= " + next(o.Since)
	}
	if !o.Until.IsZero() {
		sql += " and m.sent_at < " + next(o.Until)
	}
	// m.id breaks the remaining ties. Score ties are ordinary — two messages
	// matching the same words the same way — and two messages can share a
	// sent_at to the second, so without it the sort is only a partial order:
	// the same query can return the same rows in a different arrangement, and
	// paging would then duplicate some and skip others.
	sql += " order by paradedb.score(m.id) desc, m.sent_at desc, m.id desc limit " + next(o.Limit)
	if o.Offset > 0 {
		sql += " offset " + next(o.Offset)
	}

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.Source, &m.ThreadID, &m.Sender, &m.Subject, &m.Body,
			&m.SentAt, &m.Score, &m.Snippet, &m.AttachmentSnippet); err != nil {
			return nil, err
		}
		m.Snippet = Snippet(m.Snippet, m.Body, query)
		m.AttachmentSnippet = Snippet(m.AttachmentSnippet, "", query)
		out = append(out, m)
	}
	return out, rows.Err()
}

// GetMessageDetail is GetMessage in the shape `bank show --json` prints and
// the HTTP API serves.
func (s *Store) GetMessageDetail(ctx context.Context, id int64) (MessageDetail, error) {
	m, atts, err := s.GetMessage(ctx, id)
	return MessageDetail{Message: m, Attachments: atts}, err
}

func (s *Store) GetMessage(ctx context.Context, id int64) (Message, []Attachment, error) {
	var m Message
	err := s.pool.QueryRow(ctx, `
		select id, source, external_id, message_id, thread_id, sender, recipients, subject, body, sent_at, raw_ref
		from messages where id = $1`, id,
	).Scan(&m.ID, &m.Source, &m.ExternalID, &m.MessageID, &m.ThreadID, &m.Sender, &m.Recipients, &m.Subject, &m.Body, &m.SentAt, &m.RawRef)
	if err == pgx.ErrNoRows {
		return m, nil, ErrNotFound
	}
	if err != nil {
		return m, nil, err
	}
	atts, err := s.messageAttachments(ctx, id)
	return m, atts, err
}

func (s *Store) messageAttachments(ctx context.Context, id int64) ([]Attachment, error) {
	rows, err := s.pool.Query(ctx, `
		select a.id, a.message_id, a.filename, a.mime_type, a.size_bytes, a.sha256,
		       coalesce(t.status, '`+StatusPending+`'), coalesce(length(t.text), 0)
		from attachments a
		left join blob_text t on t.sha256 = a.sha256
		where a.message_id = $1 order by a.id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var atts []Attachment
	for rows.Next() {
		var a Attachment
		if err := rows.Scan(&a.ID, &a.MessageID, &a.Filename, &a.MimeType, &a.SizeBytes, &a.SHA256,
			&a.TextStatus, &a.TextChars); err != nil {
			return nil, err
		}
		atts = append(atts, a)
	}
	return atts, rows.Err()
}

// MaxThreadMessages bounds one `bank thread` read. A mailing-list thread or a
// years-long WhatsApp chat is not something to page into memory whole.
const MaxThreadMessages = 2000

// Thread is one conversation: every message under a thread id, oldest first.
type Thread struct {
	ThreadID string    `json:"thread_id"`
	Source   string    `json:"source"`
	Messages []Message `json:"messages"`
	// Truncated reports that the thread holds more messages than the limit
	// returned, so a caller knows it is reading a prefix.
	Truncated bool `json:"truncated"`
}

// AmbiguousThreadError says a thread id is used by more than one source, which
// only a --source can resolve; silently merging two conversations would be
// worse than refusing.
type AmbiguousThreadError struct {
	ThreadID string
	Sources  []string
}

func (e *AmbiguousThreadError) Error() string {
	return fmt.Sprintf("thread %q exists in %d sources (%s); pass --source to pick one",
		e.ThreadID, len(e.Sources), strings.Join(e.Sources, ", "))
}

// threadSources lists the sources that use a thread id.
func (s *Store) threadSources(ctx context.Context, threadID string) ([]string, error) {
	rows, err := s.pool.Query(ctx,
		`select distinct source from messages where thread_id = $1 order by source`, cleanText(threadID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var src string
		if err := rows.Scan(&src); err != nil {
			return nil, err
		}
		out = append(out, src)
	}
	return out, rows.Err()
}

// GetThread returns one conversation in chronological order. An empty source
// is resolved from the data and reported as ambiguous when it matches more
// than one; limit <= 0 means MaxThreadMessages.
func (s *Store) GetThread(ctx context.Context, source, threadID string, limit int) (Thread, error) {
	threadID = cleanText(threadID)
	out := Thread{ThreadID: threadID, Source: source, Messages: []Message{}}
	if threadID == "" {
		return out, fmt.Errorf("thread id must not be empty")
	}
	if limit <= 0 || limit > MaxThreadMessages {
		limit = MaxThreadMessages
	}
	if source == "" {
		sources, err := s.threadSources(ctx, threadID)
		if err != nil {
			return out, err
		}
		switch len(sources) {
		case 0:
			return out, ErrNotFound
		case 1:
			source = sources[0]
			out.Source = source
		default:
			return out, &AmbiguousThreadError{ThreadID: threadID, Sources: sources}
		}
	}

	// One extra row answers "is this truncated?" without a second count query.
	rows, err := s.pool.Query(ctx, fmt.Sprintf(`
		select id, source, external_id, message_id, thread_id, sender, recipients, subject, body, sent_at, raw_ref
		from messages where thread_id = $1 and source = $2
		order by sent_at, id limit %d`, limit+1), threadID, source)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.Source, &m.ExternalID, &m.MessageID, &m.ThreadID, &m.Sender,
			&m.Recipients, &m.Subject, &m.Body, &m.SentAt, &m.RawRef); err != nil {
			return out, err
		}
		out.Messages = append(out.Messages, m)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	if len(out.Messages) > limit {
		out.Messages = out.Messages[:limit]
		out.Truncated = true
	}
	if len(out.Messages) == 0 {
		return out, ErrNotFound
	}
	return out, nil
}

type SourceStats struct {
	Source   string    `json:"source"`
	Messages int64     `json:"messages"`
	Earliest time.Time `json:"earliest"`
	Latest   time.Time `json:"latest"`
	// LastIngest is when this source last gained a message — the freshness
	// signal for manually dropped exports.
	LastIngest time.Time `json:"last_ingest"`
	// LastSync is when a sync-backed source (Gmail) last advanced its
	// checkpoint. Null for sources that are imported by hand — a pointer
	// because omitempty does nothing for a zero time.Time, and an agent
	// reading "0001-01-01" as a sync date would be worse than reading nothing.
	LastSync *time.Time `json:"last_sync"`
}

func (s *Store) Stats(ctx context.Context) ([]SourceStats, error) {
	rows, err := s.pool.Query(ctx, `
		select m.source, count(*), min(m.sent_at), max(m.sent_at), max(m.ingested_at),
		       coalesce(max(ss.updated_at), 'epoch'::timestamptz)
		from messages m
		left join sync_state ss on ss.source = m.source
		group by m.source order by m.source`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SourceStats{}
	for rows.Next() {
		var st SourceStats
		var lastSync time.Time
		if err := rows.Scan(&st.Source, &st.Messages, &st.Earliest, &st.Latest, &st.LastIngest, &lastSync); err != nil {
			return nil, err
		}
		if lastSync.Unix() != 0 {
			st.LastSync = &lastSync
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

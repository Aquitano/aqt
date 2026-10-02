// Package store owns the Postgres schema and all queries. Migrations are
// embedded and applied automatically on Open, so the binary is self-contained.
package store

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"sort"
	"strconv"
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
	Mailboxes []Mailbox `json:"mailboxes,omitempty"`
	ID        int64     `json:"id"`
	// Ref is the stable citation id: 12 hex characters derived from the source
	// and the message's own identifier. ID is a row serial and changes when the
	// archive is rebuilt from its raw inputs, so a note citing "bank:<id>"
	// silently comes to mean another message; Ref does not move. Computed in
	// SQL (see refSQL), never stored.
	Ref              string    `json:"ref,omitempty"`
	Source           string    `json:"source"`
	ExternalID       string    `json:"external_id,omitempty"`
	MessageID        string    `json:"message_id,omitempty"` // RFC 822 Message-ID for mail sources
	ParentExternalID string    `json:"parent_external_id,omitempty"`
	BranchID         string    `json:"branch_id,omitempty"`
	AlternativeIndex int       `json:"alternative_index,omitempty"`
	ThreadID         string    `json:"thread_id,omitempty"`
	Sender           string    `json:"sender"`
	Recipients       []string  `json:"recipients,omitempty"`
	Subject          string    `json:"subject,omitempty"`
	Body             string    `json:"body"`
	SentAt           time.Time `json:"sent_at"`
	RawRef           string    `json:"raw_ref,omitempty"`
	Score            float64   `json:"score,omitempty"`
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

// InsertMessagesOpts selects how an import treats a message it has already
// stored. The zero value preserves the existing row exactly. Rethread updates
// the fields an importer derives from raw input and may learn to derive better
// after a parser fix; the row still counts as a duplicate in the result.
type InsertMessagesOpts struct {
	Rethread bool
}

// messageBatchSize bounds one PostgreSQL protocol batch. The whole call still
// runs in one transaction, so an import pays for one commit and remains atomic,
// while batches keep client and server buffers bounded for histories with tens
// of thousands of records.
const messageBatchSize = 1000

const insertMessageSQL = `
	insert into messages (source, external_id, message_id, thread_id, sender, recipients, subject, body, sent_at, raw_ref, parent_external_id, branch_id, alternative_index)
	values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
	on conflict do nothing
	returning id`

const rethreadMessageSQL = `
	insert into messages (source, external_id, message_id, thread_id, sender, recipients, subject, body, sent_at, raw_ref, parent_external_id, branch_id, alternative_index)
	values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
	on conflict (source, external_id) do update
		set thread_id = excluded.thread_id, subject = excluded.subject, sent_at = excluded.sent_at,
            parent_external_id = coalesce(nullif(excluded.parent_external_id, ''), messages.parent_external_id),
            branch_id = coalesce(nullif(excluded.branch_id, ''), messages.branch_id),
            alternative_index = case when excluded.alternative_index > 0 then excluded.alternative_index else messages.alternative_index end
		where messages.thread_id is distinct from excluded.thread_id
		   or messages.subject is distinct from excluded.subject
		   or messages.sent_at is distinct from excluded.sent_at
		   or (excluded.parent_external_id <> '' and messages.parent_external_id is distinct from excluded.parent_external_id)
		   or (excluded.branch_id <> '' and messages.branch_id is distinct from excluded.branch_id)
		   or (excluded.alternative_index > 0 and messages.alternative_index is distinct from excluded.alternative_index)
	returning id, xmax = 0`

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

// RefChars is how much of the digest a ref keeps. Twelve hex characters are
// short enough to paste into a citation and, at archive scale, far past the
// point where a collision is plausible.
const RefChars = 12

// refSQL is the ref expression for a messages row under the given alias. The
// digest covers the source and the message's own identifier — the RFC 822
// Message-ID where the source has one, that source's external id otherwise —
// which is exactly the pair dedup already treats as the message's identity.
// Nothing about insertion order enters it, so the same message re-imported
// into a rebuilt archive keeps the same ref.
func refSQL(alias string) string {
	return `substr(encode(sha256(convert_to(` + alias + `.source,'UTF8') || '\x00'::bytea` +
		` || convert_to(coalesce(nullif(` + alias + `.message_id,''), ` + alias + `.external_id),'UTF8')),'hex'),1,` +
		strconv.Itoa(RefChars) + `)`
}

// ValidRef rejects anything that is not a ref before it reaches a query.
func ValidRef(s string) error {
	if len(s) != RefChars || strings.TrimLeft(s, "0123456789abcdef") != "" {
		return fmt.Errorf("not a message ref: %q", s)
	}
	return nil
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

func OpenReadOnly(ctx context.Context, databaseURL string) (*Store, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	config.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{pool: pool}, nil
}

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
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `select pg_advisory_unlock($1)`, migrationLock)
	}()

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

// InsertMessages inserts a batch atomically and returns one id per input, in
// input order. An id of zero means that row was already present. Records are
// cleaned before the transaction begins, so malformed input cannot leave a
// valid prefix committed.
//
// Work is sent through bounded pgx batches inside one transaction: a 40,000-row
// history uses 40 protocol exchanges and one commit instead of 40,000 of each.
// The zero-value options use a bare "on conflict do nothing", which also
// swallows the partial unique index on (source, message_id). Rethread targets
// only (source, external_id), matching InsertMessageRethreading's contract.
func (s *Store) InsertMessages(ctx context.Context, messages []Message, o InsertMessagesOpts) ([]int64, error) {
	cleaned := make([]Message, len(messages))
	for i, m := range messages {
		var err error
		if cleaned[i], err = m.clean(); err != nil {
			return nil, fmt.Errorf("message %d: %w", i, err)
		}
	}
	ids := make([]int64, len(cleaned))
	if len(cleaned) == 0 {
		return ids, nil
	}

	// A singleton is the compatibility path used by mail ingestion. Avoid an
	// explicit BEGIN/COMMIT around the one statement; PostgreSQL's autocommit is
	// already atomic and Gmail intentionally runs several of these concurrently.
	if len(cleaned) == 1 {
		id, err := s.insertMessageRow(ctx, cleaned[0], o)
		if err != nil {
			return nil, err
		}
		ids[0] = id
		if id != 0 {
			countImported(ctx, 1, "")
		}
		return ids, nil
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	for start := 0; start < len(cleaned); start += messageBatchSize {
		end := min(start+messageBatchSize, len(cleaned))
		var batch pgx.Batch
		query := insertMessageSQL
		if o.Rethread {
			query = rethreadMessageSQL
		}
		for _, m := range cleaned[start:end] {
			batch.Queue(query, messageArgs(m)...)
		}
		results := tx.SendBatch(ctx, &batch)
		var batchErr error
		for i := start; i < end; i++ {
			ids[i], batchErr = scanMessageInsert(results.QueryRow(), o)
			if batchErr != nil {
				break
			}
		}
		if closeErr := results.Close(); batchErr == nil {
			batchErr = closeErr
		}
		if batchErr != nil {
			return nil, batchErr
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	for _, id := range ids {
		if id != 0 {
			countImported(ctx, 1, "")
		}
	}
	return ids, nil
}

func (s *Store) insertMessageRow(ctx context.Context, m Message, o InsertMessagesOpts) (int64, error) {
	query := insertMessageSQL
	if o.Rethread {
		query = rethreadMessageSQL
	}
	return scanMessageInsert(s.pool.QueryRow(ctx, query, messageArgs(m)...), o)
}

func messageArgs(m Message) []any {
	return []any{m.Source, m.ExternalID, m.MessageID, m.ThreadID, m.Sender, m.Recipients, m.Subject, m.Body, m.SentAt, m.RawRef, m.ParentExternalID, m.BranchID, m.AlternativeIndex}
}

func scanMessageInsert(row pgx.Row, o InsertMessagesOpts) (int64, error) {
	var id int64
	if !o.Rethread {
		err := row.Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return id, err
	}
	var inserted bool
	err := row.Scan(&id, &inserted)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil || !inserted {
		return 0, err
	}
	return id, nil
}

// InsertMessage is the single-record compatibility wrapper around
// InsertMessages. It is idempotent via (source, external_id) and returns zero
// when the message was already present.
func (s *Store) InsertMessage(ctx context.Context, m Message) (int64, error) {
	ids, err := s.InsertMessages(ctx, []Message{m}, InsertMessagesOpts{})
	if err != nil {
		return 0, err
	}
	return ids[0], nil
}

// InsertMessageRethreading is InsertMessage for sources whose thread id,
// subject, and sent_at are derived, and so can change when the derivation is
// fixed: an already-stored message is re-keyed onto the incoming values
// instead of being left under the old ones. Everything else about the stored
// row is kept — a re-import is not an authority on a body that may since have
// been repaired. SetLongerMessageBody is the one deliberate exception, and it
// only ever adds text.
//
// Like InsertMessage it returns (0, nil) for a message that was already
// present, re-keyed or not, so importers keep counting it as a duplicate
// rather than as new.
//
// Only (source, external_id) is treated as the conflict: a caller that also
// sets MessageID would hit the second unique index as a raw error rather than
// the silent skip InsertMessage gives it.
func (s *Store) InsertMessageRethreading(ctx context.Context, m Message) (int64, error) {
	ids, err := s.InsertMessages(ctx, []Message{m}, InsertMessagesOpts{Rethread: true})
	if err != nil {
		return 0, err
	}
	return ids[0], nil
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
	m.ParentExternalID = cleanText(m.ParentExternalID)
	m.BranchID = cleanText(m.BranchID)
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

// bodyTrimChars is the whitespace the body-length comparison ignores. Spelled
// out rather than left to btrim's default (spaces only) so the SQL guard and
// TrimmedBodyLen measure the same string.
const bodyTrimChars = " \t\n\r\f\v"

// TrimmedBodyLen is the Go side of the comparison SetLongerMessageBody makes in
// SQL: both count bytes after stripping the same whitespace, so a caller that
// decides from it agrees with the write it then asks for.
func TrimmedBodyLen(s string) int { return len(strings.Trim(s, bodyTrimChars)) }

// MessageBody reads one message's body without its attachments, for callers
// that only need to compare it.
func (s *Store) MessageBody(ctx context.Context, id int64) (string, error) {
	var body string
	err := s.pool.QueryRow(ctx, `select body from messages where id = $1`, id).Scan(&body)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return body, err
}

// SetLongerMessageBody replaces a message's body with one re-parsed from its
// archived raw input, and reports whether it did. It is the single exception to
// the rule that a re-import never rewrites a body (see
// InsertMessageRethreading): the parser has since learned to read mail whose
// stored body is a stub, and that text is only recoverable from the raw.
//
// The length comparison is the whole safety of it, and it lives in the
// statement rather than in the caller: only strictly more text than the row
// already holds is written, so the worst a wrong caller can do is nothing.
//
// The BM25 index is an ordinary Postgres index over these columns, so the
// updated body is searchable when the statement commits — nothing to refresh,
// the same reason RefreshAttachmentText needs no reindex step.
func (s *Store) SetLongerMessageBody(ctx context.Context, id int64, body string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		update messages set body = $2
		where id = $1 and octet_length(btrim($2, $3)) > octet_length(btrim(body, $3))`,
		id, cleanText(body), bodyTrimChars)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// FindMessageID returns the row id for (source, external_id), or 0 if absent.
func (s *Store) FindMessageID(ctx context.Context, source, externalID string) (int64, error) {
	var id int64
	err := s.pool.QueryRow(ctx,
		`select id from messages where source = $1 and external_id = $2`, source, cleanText(externalID)).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
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
	if errors.Is(err, pgx.ErrNoRows) {
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
	if err == nil {
		countImported(ctx, 0, a.SHA256)
	}
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
	if errors.Is(err, pgx.ErrNoRows) {
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

// SetCoverage records what a source is known to hold and what it is known to
// be missing — "Gmail from 2011, WhatsApp only the chats exported in 2025-08".
// It shares sync_state's blob because it is the same kind of fact (where this
// source stands), and it deliberately leaves updated_at alone: coverage is
// written by hand and must not read as a sync having happened. An empty text
// clears the note.
func (s *Store) SetCoverage(ctx context.Context, source, text string) error {
	source = strings.TrimSpace(cleanText(source))
	if source == "" {
		return fmt.Errorf("coverage needs a source")
	}
	_, err := s.pool.Exec(ctx, `
		insert into sync_state (source, state)
		values ($1, case when $2::text = '' then '{}'::jsonb else jsonb_build_object('coverage', $2::text) end)
		on conflict (source) do update
		set state = case when $2::text = '' then sync_state.state - 'coverage'
		                 else jsonb_set(sync_state.state, '{coverage}', to_jsonb($2::text), true) end`,
		source, cleanText(text))
	return err
}

// GetMessageDetail is GetMessage in the shape `bank show --json` prints and
// the HTTP API serves.
func (s *Store) GetMessageDetail(ctx context.Context, id int64) (MessageDetail, error) {
	m, atts, err := s.GetMessage(ctx, id)
	return MessageDetail{Message: m, Attachments: atts}, err
}

// GetMessageDetailByRef is GetMessageDetail addressed by the stable ref, the
// form a citation carries.
func (s *Store) GetMessageDetailByRef(ctx context.Context, ref string) (MessageDetail, error) {
	m, atts, err := s.GetMessageByRef(ctx, ref)
	return MessageDetail{Message: m, Attachments: atts}, err
}

// messageColumns is the full row every single-message read returns, with the
// ref computed alongside it.
var messageColumns = `m.id, ` + refSQL("m") + `, m.source, m.external_id, m.message_id, m.thread_id,
	m.sender, m.recipients, m.subject, m.body, m.sent_at, m.raw_ref, m.parent_external_id, m.branch_id, m.alternative_index`

func (m *Message) scanFull(row pgx.Row) error {
	return row.Scan(&m.ID, &m.Ref, &m.Source, &m.ExternalID, &m.MessageID, &m.ThreadID,
		&m.Sender, &m.Recipients, &m.Subject, &m.Body, &m.SentAt, &m.RawRef, &m.ParentExternalID, &m.BranchID, &m.AlternativeIndex)
}

func (s *Store) GetMessage(ctx context.Context, id int64) (Message, []Attachment, error) {
	var m Message
	err := m.scanFull(s.pool.QueryRow(ctx,
		`select `+messageColumns+` from messages m where m.id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return m, nil, ErrNotFound
	}
	if err != nil {
		return m, nil, err
	}
	details := []MessageDetail{{Message: m}}
	err = s.loadAttachments(ctx, details)
	return details[0].Message, details[0].Attachments, err
}

// GetMessageByRef resolves a citation. There is no index on the ref: the
// expression is derived, the archive is one person's mail, and a sequential
// scan answers in a fraction of a second — cheaper than a stored column that
// could disagree with the formula.
func (s *Store) GetMessageByRef(ctx context.Context, ref string) (Message, []Attachment, error) {
	var m Message
	if err := ValidRef(ref); err != nil {
		return m, nil, err
	}
	err := m.scanFull(s.pool.QueryRow(ctx,
		`select `+messageColumns+` from messages m where `+refSQL("m")+` = $1 order by m.id limit 1`, ref))
	if errors.Is(err, pgx.ErrNoRows) {
		return m, nil, ErrNotFound
	}
	if err != nil {
		return m, nil, err
	}
	details := []MessageDetail{{Message: m}}
	err = s.loadAttachments(ctx, details)
	return details[0].Message, details[0].Attachments, err
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
	// Coverage is the owner's note on what this source actually holds, set
	// with `bank coverage`. Absence of a message only means something once you
	// know the source was ever complete for that period.
	Coverage string `json:"coverage,omitempty"`
	// Stale reports that nothing has landed here in StaleAfter, which for a
	// source that should be growing means the drop-off went unnoticed.
	Stale bool `json:"stale"`
}

// StaleAfter is how long a source may go without a new message before stats
// flags it. Long enough that a quiet month is not an alarm, short enough that a
// sync which stopped working is noticed within the quarter.
const StaleAfter = 30 * 24 * time.Hour

func (s *Store) Stats(ctx context.Context) ([]SourceStats, error) {
	// A row that only carries a coverage note is not a sync checkpoint, so it
	// must not report a last_sync: `bank coverage` writes into the same blob.
	// The type check keeps a state blob that is not an object (nothing writes
	// one today) from failing the whole of `bank stats` on the `-` operator.
	rows, err := s.pool.Query(ctx, `
		select m.source, count(*), min(m.sent_at), max(m.sent_at), max(m.ingested_at),
		       coalesce(max(ss.updated_at) filter (
		           where jsonb_typeof(ss.state) <> 'object' or ss.state - 'coverage' <> '{}'::jsonb),
		           'epoch'::timestamptz),
		       coalesce(max(ss.state ->> 'coverage'), '')
		from messages m
		left join sync_state ss on ss.source = m.source
		group by m.source order by m.source`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SourceStats{}
	now := time.Now()
	for rows.Next() {
		var st SourceStats
		var lastSync time.Time
		if err := rows.Scan(&st.Source, &st.Messages, &st.Earliest, &st.Latest, &st.LastIngest,
			&lastSync, &st.Coverage); err != nil {
			return nil, err
		}
		if lastSync.Unix() != 0 {
			st.LastSync = &lastSync
		}
		st.Stale = now.Sub(st.LastIngest) > StaleAfter
		out = append(out, st)
	}
	return out, rows.Err()
}

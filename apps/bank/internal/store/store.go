// Package store holds every query on bank's tables: the archive's and the
// catalogue of files on disks. The schema is package db's.
package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	pool      *pgxpool.Pool
	queryPool *pgxpool.Pool
}

type Message struct {
	Mail      *MailProvenance `json:"mail,omitempty"`
	Mailboxes []Mailbox       `json:"mailboxes,omitempty"`
	// ID is the row number joins use. It changes when the archive is rebuilt
	// from its raw inputs, so it never leaves the process; Ref is what
	// callers see and cite.
	ID               int64     `json:"-"`
	Ref              string    `json:"ref" doc:"What to cite: msg:<16 hex>."`
	Source           string    `json:"source"`
	ExternalID       string    `json:"external_id,omitempty"`
	MessageID        string    `json:"message_id,omitempty"` // RFC 822 Message-ID for mail sources
	ParentExternalID string    `json:"parent_external_id,omitempty"`
	BranchID         string    `json:"branch_id,omitempty"`
	AlternativeIndex int       `json:"alternative_index,omitempty"`
	ThreadID         string    `json:"thread_id,omitempty" doc:"The conversation, which getThread reads with this ID and the source."`
	Sender           string    `json:"sender"`
	Recipients       []string  `json:"recipients,omitempty"`
	Subject          string    `json:"subject,omitempty"`
	Body             string    `json:"body"`
	SentAt           time.Time `json:"sent_at,omitzero" doc:"Absent when the source gave no date."`
	RawInput         int64     `json:"raw_input,omitempty"`
	RawLocator       string    `json:"raw_locator,omitempty"`
}

// messageBatchSize bounds one PostgreSQL protocol batch. The whole call still
// runs in one transaction, so a batch of messages and their attachments
// commits together or not at all.
const messageBatchSize = 1000

// notRetired makes every import skip a message `bank retire` removed, so
// replaying the raw input that first brought it in cannot resurrect it. Mail
// can come back under another external id, so the Message-ID is checked too.
const notRetired = `
	where not exists (select 1 from message_tombstones t
		where t.source = $1 and (t.external_id = $2 or ($3 <> '' and t.message_id = $3)))`

const insertMessageSQL = `
	insert into messages (source, external_id, message_id, thread_id, sender, recipients, subject, body, sent_at, raw_input_id, raw_locator, parent_external_id, branch_id, alternative_index, ref)
	select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15` + notRetired + `
	on conflict do nothing
	returning id`

// existingMessageSQL finds the row a skipped insert collided with, by
// Message-ID first so mail that arrives under two id schemes resolves to one
// row. No row means the message was retired.
const existingMessageSQL = `
	select id from messages
	where source = $1 and (external_id = $2 or ($3 <> '' and message_id = $3))
	order by ($3 <> '' and message_id = $3) desc, id limit 1`

type Attachment struct {
	MessageID  int64          `json:"-"`
	Position   int            `json:"position"`
	Filename   string         `json:"filename"`
	MimeType   string         `json:"mime_type,omitempty"`
	SizeBytes  int64          `json:"size_bytes"`
	BLAKE3     content.Digest `json:"blake3" doc:"The digest of the bytes. content: followed by it is their ref."`
	TextStatus string         `json:"text_status,omitempty" doc:"What reading text from the bytes came to, such as ok, needs_ocr, failed or pending. Search finds words inside a file only when text was read."`
	TextChars  int            `json:"text_chars,omitempty" doc:"How many characters of text were read."`
}

// MessageDetail is one message plus its attachments — the shape `bank show
// --json` prints and GET /v1/messages/{ref} returns, shared so both emit one format.
type MessageDetail struct {
	Message
	Attachments []Attachment `json:"attachments,omitempty"`
}

// ErrNotFound is returned when a lookup found no row, so callers can tell an
// absent message from a broken database.
var ErrNotFound = errors.New("not found")

// New queries through pool, which stays its opener's to close.
func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// CloseQuery closes the connection ConfigureQuery opened.
func (s *Store) CloseQuery() {
	if s.queryPool != nil {
		s.queryPool.Close()
	}
}

// SchemaVersion is the migration the database is at, read from the database
// itself, so it also says the database answers.
func (s *Store) SchemaVersion(ctx context.Context) (int32, error) {
	var version int32
	err := s.pool.QueryRow(ctx, `select version from public.schema_version`).Scan(&version)
	return version, err
}

// Record is one message to write with its attachments, whose bytes are
// already in the blob store. An attachment's Position keys it within the
// message.
type Record struct {
	Message     Message
	Attachments []Attachment
	Mail        *Mail
}

// Written is what WriteMessages did with one record.
type Written struct {
	// ID is the message's row, new or existing; zero when it was retired.
	ID       int64
	Inserted bool
	// Attachments counts the attachment rows this call added.
	Attachments int
}

// WriteMessages writes records and their attachments in one transaction and
// reports one Written per record, in order. A message already stored keeps
// its row; its attachments are added at the positions it does not hold yet,
// so repeating an import, or running it twice at once, writes nothing twice.
// Records are cleaned before the transaction begins, so malformed input
// cannot leave a valid prefix committed.
func (s *Store) WriteMessages(ctx context.Context, records []Record) ([]Written, error) {
	cleaned := make([]Message, len(records))
	for i, r := range records {
		var err error
		if cleaned[i], err = r.Message.clean(); err != nil {
			return nil, fmt.Errorf("message %d: %w", i, err)
		}
		if r.Mail != nil && r.Mail.Mailbox != nil {
			if err := r.Mail.Mailbox.Validate(); err != nil {
				return nil, fmt.Errorf("message %d: %w", i, err)
			}
		}
	}
	out := make([]Written, len(records))
	if len(records) == 0 {
		return out, nil
	}
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		for start := 0; start < len(cleaned); start += messageBatchSize {
			end := min(start+messageBatchSize, len(cleaned))
			if err := insertMessages(ctx, tx, cleaned[start:end], out[start:end]); err != nil {
				return err
			}
		}
		var skipped []Message
		for i, w := range out {
			if !w.Inserted {
				skipped = append(skipped, cleaned[i])
			}
		}
		if err := refCollisions(ctx, tx.Query, skipped); err != nil {
			return err
		}
		if err := threadMail(ctx, tx, cleaned, records, out); err != nil {
			return err
		}
		return insertAttachments(ctx, tx, records, out)
	})
	return out, err
}

func insertMessages(ctx context.Context, tx pgx.Tx, messages []Message, out []Written) error {
	var batch pgx.Batch
	for _, m := range messages {
		batch.Queue(insertMessageSQL, m.Source, m.ExternalID, m.MessageID, m.ThreadID, m.Sender, m.Recipients, m.Subject, m.Body,
			nullTime(m.SentAt), nullID(m.RawInput), m.RawLocator, m.ParentExternalID, m.BranchID, m.AlternativeIndex, m.Ref)
	}
	results := tx.SendBatch(ctx, &batch)
	for i := range messages {
		err := results.QueryRow().Scan(&out[i].ID)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			results.Close()
			return err
		}
		out[i].Inserted = true
	}
	if err := results.Close(); err != nil {
		return err
	}
	for i, m := range messages {
		if out[i].Inserted {
			continue
		}
		err := tx.QueryRow(ctx, existingMessageSQL, m.Source, m.ExternalID, m.MessageID).Scan(&out[i].ID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	return nil
}

func insertAttachments(ctx context.Context, tx pgx.Tx, records []Record, out []Written) error {
	var contentIDs []int64
	for i, r := range records {
		if out[i].ID == 0 {
			continue
		}
		for _, a := range r.Attachments {
			a.MessageID = out[i].ID
			contentID, added, err := insertAttachment(ctx, tx, a)
			if err != nil {
				return err
			}
			if added {
				out[i].Attachments++
				contentIDs = append(contentIDs, contentID)
			}
		}
	}
	return queueText(ctx, tx, contentIDs)
}

// InsertMessages writes messages without attachments and returns one id per
// input, zero for one that was already stored or retired.
func (s *Store) InsertMessages(ctx context.Context, messages []Message) ([]int64, error) {
	records := make([]Record, len(messages))
	for i, m := range messages {
		records[i] = Record{Message: m}
	}
	written, err := s.WriteMessages(ctx, records)
	if err != nil {
		return nil, err
	}
	ids := make([]int64, len(written))
	for i, w := range written {
		if w.Inserted {
			ids[i] = w.ID
		}
	}
	return ids, nil
}

func (s *Store) InsertMessage(ctx context.Context, m Message) (int64, error) {
	ids, err := s.InsertMessages(ctx, []Message{m})
	if err != nil {
		return 0, err
	}
	return ids[0], nil
}

// InsertAttachment writes one attachment at its position, unless the message
// already holds one there.
func (s *Store) InsertAttachment(ctx context.Context, a Attachment) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		contentID, added, err := insertAttachment(ctx, tx, a)
		if err != nil || !added {
			return err
		}
		return queueText(ctx, tx, []int64{contentID})
	})
}

// refCollisions fails when a skipped message's ref already belongs to a
// different message. The bare "on conflict do nothing" that skips duplicates
// would otherwise skip the collision too, and a citation would name a message
// that is not the one cited.
func refCollisions(ctx context.Context, query func(context.Context, string, ...any) (pgx.Rows, error), skipped []Message) error {
	if len(skipped) == 0 {
		return nil
	}
	refs, sources, externalIDs, messageIDs := make([]string, len(skipped)), make([]string, len(skipped)), make([]string, len(skipped)), make([]string, len(skipped))
	for i, m := range skipped {
		refs[i], sources[i], externalIDs[i], messageIDs[i] = m.Ref, m.Source, m.ExternalID, m.MessageID
	}
	rows, err := query(ctx, `
		select k.ref from unnest($1::text[], $2::text[], $3::text[], $4::text[]) as k(ref, source, external_id, message_id)
		join messages m on m.ref = k.ref
		where m.source <> k.source or m.message_id <> k.message_id
		   or (k.message_id = '' and m.external_id <> k.external_id)`,
		refs, sources, externalIDs, messageIDs)
	if err != nil {
		return err
	}
	collided, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	if len(collided) > 0 {
		return fmt.Errorf("message ref collision: %s already names another message", strings.Join(collided, ", "))
	}
	return nil
}

// clean normalizes every text field to what the columns accept and rejects a
// message that could not be identified.
func (m Message) clean() (Message, error) {
	m.ExternalID = CleanText(m.ExternalID)
	m.MessageID = CleanText(m.MessageID)
	if m.Source == "" || m.ExternalID == "" {
		return m, fmt.Errorf("message needs source (%q) and external_id (%q)", m.Source, m.ExternalID)
	}
	m.Ref = ref.ForMessage(m.Source, m.MessageID, m.ExternalID).String()
	recipients := make([]string, len(m.Recipients))
	for i, r := range m.Recipients {
		recipients[i] = CleanText(r)
	}
	m.Recipients = recipients
	m.Sender = CleanText(m.Sender)
	m.Subject = CleanText(m.Subject)
	m.Body = CleanText(m.Body)
	m.ThreadID = CleanText(m.ThreadID)
	m.ParentExternalID = CleanText(m.ParentExternalID)
	m.BranchID = CleanText(m.BranchID)
	m.RawLocator = CleanText(m.RawLocator)
	return m, nil
}

// CleanText makes a string safe for a Postgres text column: valid UTF-8
// (mislabeled legacy charsets are common in old email, and file names on old
// disks are not always valid UTF-16) and no NUL bytes. Identifiers get the
// same treatment as bodies: a Message-ID with a stray 0x00 would otherwise
// fail insertion and, on Gmail, wedge the whole sync.
func CleanText(s string) string {
	if utf8.ValidString(s) && !strings.ContainsRune(s, 0) {
		return s
	}
	s = strings.ToValidUTF8(s, "�")
	return strings.ReplaceAll(s, "\x00", "")
}

// nullTime writes an unknown date as null.
func nullTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}

func nullID(id int64) any {
	if id == 0 {
		return nil
	}
	return id
}

// optionalTime scans a nullable timestamptz, leaving the zero time for null.
type optionalTime struct{ t *time.Time }

func (o optionalTime) Scan(src any) error {
	switch v := src.(type) {
	case nil:
		*o.t = time.Time{}
	case time.Time:
		*o.t = v
	default:
		return fmt.Errorf("cannot scan %T into a time", src)
	}
	return nil
}

// FindMessageID returns the row id for (source, external_id), or 0 if absent.
func (s *Store) FindMessageID(ctx context.Context, source, externalID string) (int64, error) {
	var id int64
	err := s.pool.QueryRow(ctx,
		`select id from messages where source = $1 and external_id = $2`, source, CleanText(externalID)).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return id, err
}

// FindByEmailMessageID returns the row id of a mail already archived for the
// source under this RFC 822 Message-ID, regardless of which id scheme keyed
// it, or 0 if absent.
func (s *Store) FindByEmailMessageID(ctx context.Context, source, messageID string) (int64, error) {
	messageID = CleanText(messageID)
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
		on conflict (source) do update set state = sync_state.state || excluded.state, updated_at = now()`,
		source, state)
	return err
}

// SetNote records what a source is known to hold and what it is known to
// be missing — "Gmail from 2011, WhatsApp only the chats exported in 2025-08".
// It shares sync_state's blob because it is the same kind of fact (where this
// source stands), and it deliberately leaves updated_at alone: the note is
// written by hand and must not read as a sync having happened. An empty text
// clears the note.
func (s *Store) SetNote(ctx context.Context, source, text string) error {
	source = strings.TrimSpace(CleanText(source))
	if source == "" {
		return fail.Invalidf("a note needs a source")
	}
	_, err := s.pool.Exec(ctx, `
		insert into sync_state (source, state)
		values ($1, case when $2::text = '' then '{}'::jsonb else jsonb_build_object('note', $2::text) end)
		on conflict (source) do update
		set state = case when $2::text = '' then sync_state.state - 'note'
		                 else jsonb_set(sync_state.state, '{note}', to_jsonb($2::text), true) end`,
		source, CleanText(text))
	return err
}

// GetMessageDetail is GetMessage in the shape `bank show --json` prints and
// the HTTP API serves.
func (s *Store) GetMessageDetail(ctx context.Context, id int64) (MessageDetail, error) {
	m, atts, err := s.GetMessage(ctx, id)
	return MessageDetail{Message: m, Attachments: atts}, err
}

// GetMessageDetailByRef is GetMessageDetail addressed by the ref a citation
// carries.
func (s *Store) GetMessageDetailByRef(ctx context.Context, r ref.Message) (MessageDetail, error) {
	m, atts, err := s.GetMessageByRef(ctx, r)
	return MessageDetail{Message: m, Attachments: atts}, err
}

// messageColumns is the full row every single-message read returns.
const messageColumns = `m.id, m.ref, m.source, m.external_id, m.message_id, m.thread_id,
	m.sender, m.recipients, m.subject, m.body, m.sent_at, coalesce(m.raw_input_id, 0), m.raw_locator, m.parent_external_id, m.branch_id, m.alternative_index`

func (m *Message) scanFull(row pgx.Row) error {
	return row.Scan(&m.ID, &m.Ref, &m.Source, &m.ExternalID, &m.MessageID, &m.ThreadID,
		&m.Sender, &m.Recipients, &m.Subject, &m.Body, optionalTime{&m.SentAt}, &m.RawInput, &m.RawLocator, &m.ParentExternalID, &m.BranchID, &m.AlternativeIndex)
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

// GetMessageByRef resolves a citation. A ref whose message was retired
// returns a *RetiredError, which still matches ErrNotFound.
func (s *Store) GetMessageByRef(ctx context.Context, r ref.Message) (Message, []Attachment, error) {
	var m Message
	err := m.scanFull(s.pool.QueryRow(ctx, `select `+messageColumns+` from messages m where m.ref = $1`, r.String()))
	if errors.Is(err, pgx.ErrNoRows) {
		retired, err := s.RetiredByRef(ctx, r)
		if err != nil {
			return m, nil, err
		}
		return m, nil, &RetiredError{Retired: retired}
	}
	if err != nil {
		return m, nil, err
	}
	details := []MessageDetail{{Message: m}}
	err = s.loadAttachments(ctx, details)
	return details[0].Message, details[0].Attachments, err
}

type SourceStats struct {
	Source     string    `json:"source"`
	Messages   int64     `json:"messages"`
	Undated    int64     `json:"undated" doc:"Messages whose source gave no date. earliest and latest describe the others, and are absent when there are none."`
	Earliest   time.Time `json:"earliest,omitzero"`
	Latest     time.Time `json:"latest,omitzero"`
	LastIngest time.Time `json:"last_ingest" doc:"When this source last gained a message."`
	// A pointer because omitempty does nothing for a zero time.Time, and an
	// agent reading "0001-01-01" as a sync date would be worse than nothing.
	LastSync *time.Time `json:"last_sync" doc:"When a source that syncs, such as Gmail, last advanced its checkpoint. Null for sources imported by hand."`
	Note     string     `json:"note,omitempty" doc:"The owner's note on what this source holds. A missing message means something only once the source is known to be complete for that period."`
	Stale    bool       `json:"stale" doc:"Nothing has landed here for 30 days, which for a source that should grow means an import stopped."`
}

// StaleAfter is how long a source may go without a new message before stats
// flags it. Long enough that a quiet month is not an alarm, short enough that a
// sync which stopped working is noticed within the quarter.
const StaleAfter = 30 * 24 * time.Hour

func (s *Store) Stats(ctx context.Context) ([]SourceStats, error) {
	// A row that only carries a note is not a sync checkpoint, so it must not
	// report a last_sync: `bank note` writes into the same blob.
	// The type check keeps a state blob that is not an object (nothing writes
	// one today) from failing the whole of `bank stats` on the `-` operator.
	rows, err := s.pool.Query(ctx, `
		select m.source, count(*), count(*) filter (where m.sent_at is null), min(m.sent_at), max(m.sent_at), max(m.ingested_at),
		       coalesce(max(ss.updated_at) filter (
		           where jsonb_typeof(ss.state) <> 'object' or ss.state - 'note' <> '{}'::jsonb),
		           'epoch'::timestamptz),
		       coalesce(max(ss.state ->> 'note'), '')
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
		if err := rows.Scan(&st.Source, &st.Messages, &st.Undated, optionalTime{&st.Earliest}, optionalTime{&st.Latest}, &st.LastIngest,
			&lastSync, &st.Note); err != nil {
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

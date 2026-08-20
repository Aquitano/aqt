package store

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Contact is the owner's own name for one person, plus the source-specific
// identities that mean them. The messages themselves are never touched: a
// contact is a lens over them, so detaching an alias fully undoes a wrong
// attribution and the identity each source recorded is always still there.
type Contact struct {
	ID        int64          `json:"id"`
	Name      string         `json:"name"`
	Note      string         `json:"note,omitempty"`
	CreatedAt time.Time      `json:"created_at"`
	Aliases   []ContactAlias `json:"aliases"`
}

type ContactAlias struct {
	// Source is "" for an alias that matches everywhere, or one source name.
	Source string `json:"source,omitempty"`
	// Value is what the owner typed; Normalized is what matching compares.
	Value      string `json:"value"`
	Normalized string `json:"normalized"`
}

// ContactSourceCount is how many messages one source contributes to a contact.
type ContactSourceCount struct {
	Source   string `json:"source"`
	Messages int64  `json:"messages"`
}

// IdentitySuggestion is an identity in the archive that no contact claims yet,
// with enough context to decide whose it is. Suggestions are advisory only —
// nothing is ever attached without being asked for, so an automatic merge
// cannot happen behind the owner's back.
type IdentitySuggestion struct {
	Identity string   `json:"identity"`
	Messages int64    `json:"messages"`
	Sources  []string `json:"sources"`
	Samples  []string `json:"samples"`
}

// ErrNoContact reports a filter naming a contact that does not exist. It is a
// usage mistake, not an empty result: silently returning nothing would read as
// "this person said nothing", which is a different and wrong answer.
type ErrNoContact struct{ Name string }

func (e *ErrNoContact) Error() string {
	return fmt.Sprintf("no contact %q — see 'bank contact list'", e.Name)
}

// ErrConflict reports that an alias would make one identity mean two people.
type ErrConflict struct {
	Alias string
	Owner string
}

func (e *ErrConflict) Error() string {
	return fmt.Sprintf("alias %q already belongs to contact %q", e.Alias, e.Owner)
}

// aliasMatch is the predicate deciding whether message m belongs to the
// contact named by the given placeholder. An alias matches when any form of
// the sender, or of any recipient, equals it — and, for a scoped alias, when
// the source agrees too.
func aliasMatch(contactPlaceholder string) string {
	return `
	exists (
		select 1 from contact_aliases a
		where a.contact_id = ` + contactPlaceholder + `
		  and (a.source = '' or a.source = m.source)
		  and (a.value_norm = any (bank_identity_keys(m.sender))
		       or exists (select 1 from unnest(m.recipients) r
		                  where a.value_norm = any (bank_identity_keys(r))))
	)`
}

func (s *Store) CreateContact(ctx context.Context, name, note string) (Contact, error) {
	name = strings.TrimSpace(cleanText(name))
	if name == "" {
		return Contact{}, fmt.Errorf("contact name must not be empty")
	}
	c := Contact{Name: name, Note: cleanText(note), Aliases: []ContactAlias{}}
	err := s.pool.QueryRow(ctx,
		`insert into contacts (name, note) values ($1, $2)
		 on conflict (name) do nothing
		 returning id, created_at`, name, c.Note).Scan(&c.ID, &c.CreatedAt)
	if err == pgx.ErrNoRows {
		return Contact{}, fmt.Errorf("contact %q already exists", name)
	}
	return c, err
}

func (s *Store) DeleteContact(ctx context.Context, name string) error {
	tag, err := s.pool.Exec(ctx, `delete from contacts where name = $1`, strings.TrimSpace(cleanText(name)))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// GetContact returns one contact with its aliases, or ErrNotFound.
func (s *Store) GetContact(ctx context.Context, name string) (Contact, error) {
	var c Contact
	err := s.pool.QueryRow(ctx,
		`select id, name, note, created_at from contacts where name = $1`,
		strings.TrimSpace(cleanText(name))).Scan(&c.ID, &c.Name, &c.Note, &c.CreatedAt)
	if err == pgx.ErrNoRows {
		return c, ErrNotFound
	}
	if err != nil {
		return c, err
	}
	c.Aliases, err = s.contactAliases(ctx, c.ID)
	return c, err
}

// ContactDetail is a contact plus where its messages actually are — the
// answer to "did this alias catch anything?". The shape `bank contact show
// --json` prints and GET /v1/contacts/{name} returns, shared so both emit
// one format.
type ContactDetail struct {
	Contact
	Sources []ContactSourceCount `json:"sources"`
}

// GetContactDetail returns one contact with its per-source message counts,
// or ErrNotFound.
func (s *Store) GetContactDetail(ctx context.Context, name string) (ContactDetail, error) {
	c, err := s.GetContact(ctx, name)
	if err != nil {
		return ContactDetail{}, err
	}
	counts, err := s.ContactSourceCounts(ctx, c.ID)
	return ContactDetail{Contact: c, Sources: counts}, err
}

func (s *Store) contactAliases(ctx context.Context, contactID int64) ([]ContactAlias, error) {
	rows, err := s.pool.Query(ctx,
		`select source, value, value_norm from contact_aliases
		 where contact_id = $1 order by source, value_norm`, contactID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ContactAlias{}
	for rows.Next() {
		var a ContactAlias
		if err := rows.Scan(&a.Source, &a.Value, &a.Normalized); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) ListContacts(ctx context.Context) ([]Contact, error) {
	rows, err := s.pool.Query(ctx, `select id, name, note, created_at from contacts order by name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Contact{}
	for rows.Next() {
		var c Contact
		if err := rows.Scan(&c.ID, &c.Name, &c.Note, &c.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if out[i].Aliases, err = s.contactAliases(ctx, out[i].ID); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// AddAlias attaches one identity to a contact. Normalization happens in SQL so
// the stored form and the matching form can never drift apart.
func (s *Store) AddAlias(ctx context.Context, name, source, value string) (ContactAlias, error) {
	var a ContactAlias
	value = strings.TrimSpace(cleanText(value))
	if value == "" {
		return a, fmt.Errorf("alias must not be empty")
	}
	c, err := s.GetContact(ctx, name)
	if err != nil {
		return a, err
	}
	var norm string
	if err := s.pool.QueryRow(ctx, `select bank_identity_key($1)`, value).Scan(&norm); err != nil {
		return a, err
	}
	if norm == "" {
		return a, fmt.Errorf("alias %q normalizes to nothing", value)
	}
	// An overlap would make one identity resolve to two people, silently. Refuse
	// it here rather than at the unique index, so the error can say who has it.
	owner, err := s.aliasOwner(ctx, c.ID, source, norm)
	if err != nil {
		return a, err
	}
	if owner != "" {
		return a, &ErrConflict{Alias: norm, Owner: owner}
	}
	_, err = s.pool.Exec(ctx,
		`insert into contact_aliases (contact_id, source, value, value_norm)
		 values ($1, $2, $3, $4) on conflict (source, value_norm) do nothing`,
		c.ID, source, value, norm)
	return ContactAlias{Source: source, Value: value, Normalized: norm}, err
}

// aliasOwner names the other contact whose alias would overlap this one. Two
// aliases overlap when they share a normalized value and their scopes can both
// apply to the same message — which a global alias always can.
func (s *Store) aliasOwner(ctx context.Context, contactID int64, source, norm string) (string, error) {
	var owner string
	err := s.pool.QueryRow(ctx, `
		select c.name from contact_aliases a
		join contacts c on c.id = a.contact_id
		where a.value_norm = $1 and a.contact_id <> $2
		  and ($3 = '' or a.source = '' or a.source = $3)
		limit 1`, norm, contactID, source).Scan(&owner)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	return owner, err
}

// RemoveAlias detaches one identity. Matching stops immediately and the
// messages are untouched, which is what makes a wrong attachment reversible.
func (s *Store) RemoveAlias(ctx context.Context, name, source, value string) error {
	c, err := s.GetContact(ctx, name)
	if err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, `
		delete from contact_aliases
		where contact_id = $1 and source = $2 and value_norm = bank_identity_key($3)`,
		c.ID, source, strings.TrimSpace(cleanText(value)))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("contact %q has no alias %q in scope %q", name, value, scopeName(source))
	}
	return nil
}

func scopeName(source string) string {
	if source == "" {
		return "all sources"
	}
	return source
}

// ContactSourceCounts reports how many messages each source contributes, the
// quickest way to see that a contact spans more than one of them.
func (s *Store) ContactSourceCounts(ctx context.Context, contactID int64) ([]ContactSourceCount, error) {
	rows, err := s.pool.Query(ctx,
		`select m.source, count(*) from messages m where`+aliasMatch("$1")+
			` group by m.source order by m.source`, contactID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ContactSourceCount{}
	for rows.Next() {
		var c ContactSourceCount
		if err := rows.Scan(&c.Source, &c.Messages); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ContactMessagesOpts narrows a contact's history the same way search does.
type ContactMessagesOpts struct {
	Source string
	Since  time.Time
	Until  time.Time
	Limit  int
	// Offset pages past the first Limit messages. A correspondence of years
	// does not fit in one page, and this is the query most likely to exceed
	// it.
	Offset int
}

// ContactMessages returns one person's messages across every source, newest
// first. There is no full-text index behind this — it is a scan over a
// personal archive, which is fast enough and keeps the matching rule in one
// readable place.
func (s *Store) ContactMessages(ctx context.Context, name string, o ContactMessagesOpts) ([]Message, error) {
	c, err := s.GetContact(ctx, name)
	if err != nil {
		return nil, err
	}
	if o.Limit <= 0 {
		o.Limit = 50
	}
	if o.Limit > MaxSearchLimit {
		return nil, fmt.Errorf("limit must be at most %d", MaxSearchLimit)
	}
	if o.Offset < 0 {
		return nil, fmt.Errorf("offset must not be negative")
	}
	if o.Offset > MaxSearchOffset {
		return nil, fmt.Errorf("offset must be at most %d; narrow with --source or --since instead", MaxSearchOffset)
	}
	sql := `select m.id, m.source, m.external_id, m.message_id, m.thread_id, m.sender,
	               m.recipients, m.subject, m.body, m.sent_at, m.raw_ref
	        from messages m where` + aliasMatch("$1")
	args := []any{c.ID}
	next := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}
	if o.Source != "" {
		sql += " and m.source = " + next(o.Source)
	}
	if !o.Since.IsZero() {
		sql += " and m.sent_at >= " + next(o.Since)
	}
	if !o.Until.IsZero() {
		sql += " and m.sent_at < " + next(o.Until)
	}
	sql += " order by m.sent_at desc, m.id desc limit " + next(o.Limit)
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
		if err := rows.Scan(&m.ID, &m.Source, &m.ExternalID, &m.MessageID, &m.ThreadID, &m.Sender,
			&m.Recipients, &m.Subject, &m.Body, &m.SentAt, &m.RawRef); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// SuggestIdentities ranks the identities no contact claims yet by how much
// mail they account for, so attaching the people who actually matter does not
// start with guessing what the archive calls them.
func (s *Store) SuggestIdentities(ctx context.Context, limit int) ([]IdentitySuggestion, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > MaxSearchLimit {
		return nil, fmt.Errorf("limit must be at most %d", MaxSearchLimit)
	}
	rows, err := s.pool.Query(ctx, `
		with seen as (
			select bank_identity_key(m.sender) as identity, m.source, m.sender as sample
			from messages m where m.sender <> ''
			union all
			select bank_identity_key(r), m.source, r
			from messages m, unnest(m.recipients) r where r <> ''
		)
		select identity, count(*), array_agg(distinct source), (array_agg(distinct sample))[1:3]
		from seen
		where identity <> ''
		  and not exists (
			select 1 from contact_aliases a
			where a.value_norm = seen.identity and (a.source = '' or a.source = seen.source))
		group by identity
		order by count(*) desc, identity
		limit $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []IdentitySuggestion{}
	for rows.Next() {
		var s IdentitySuggestion
		if err := rows.Scan(&s.Identity, &s.Messages, &s.Sources, &s.Samples); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ContactAliasScope splits an alias written as "source:value" into its parts.
// A bare value is global, which is the default the owner asked for: the
// identities worth attaching are unique handles, not common first names.
func ContactAliasScope(alias string, knownSource func(string) bool) (source, value string) {
	prefix, rest, ok := strings.Cut(alias, ":")
	if !ok || rest == "" || strings.ContainsAny(prefix, "@ ") || !knownSource(prefix) {
		return "", alias
	}
	return prefix, rest
}

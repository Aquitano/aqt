package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/page"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
)

// Contact is the owner's own name for one person, plus the source-specific
// identities that mean them. The messages themselves are never touched: a
// contact is a lens over them, so detaching an alias fully undoes a wrong
// attribution and the identity each source recorded is always still there.
type Contact struct {
	ID        int64          `json:"id"`
	Name      string         `json:"name"`
	Note      string         `json:"note,omitempty"`
	Self      bool           `json:"self,omitempty" doc:"The archive's owner, whom browse leaves out of a thread's members."`
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
// the sender, or of any recipient, equals it and, for a scoped alias, when
// the source agrees too: m.participants holds both spellings, which the GIN
// index on it finds.
func aliasMatch(contactPlaceholder string) string {
	return ` m.participants && array(select case when a.source = '' then a.value_norm else a.source || chr(31) || a.value_norm end
		from contact_aliases a where a.contact_id = ` + contactPlaceholder + `)`
}

func (s *Store) CreateContact(ctx context.Context, name, note string) (Contact, error) {
	name = strings.TrimSpace(cleanText(name))
	if name == "" {
		return Contact{}, fail.Invalidf("contact name must not be empty")
	}
	c := Contact{Name: name, Note: cleanText(note), Aliases: []ContactAlias{}}
	err := s.pool.QueryRow(ctx,
		`insert into contacts (name, note) values ($1, $2)
		 on conflict (name) do nothing
		 returning id, created_at`, name, c.Note).Scan(&c.ID, &c.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Contact{}, fail.Invalidf("contact %q already exists", name)
	}
	return c, err
}

// ContactImport is one contact in a bulk import: the owner's name for a person
// and every identity that means them. Aliases arrive already split into scope
// and value — reading "whatsapp:Alice" as a scope needs the list of known
// sources, which is the CLI's job.
type ContactImport struct {
	Name    string          `json:"name"`
	Note    string          `json:"note,omitempty"`
	Aliases []ImportedAlias `json:"aliases,omitempty"`
}

// ImportedAlias is one identity to attach; an empty Source matches everywhere.
type ImportedAlias struct {
	Source string `json:"source,omitempty"`
	Value  string `json:"value"`
}

// ContactImportResult is what happened to one entry. Errors are per-alias and
// per-contact, never fatal: one identity another contact already claims must
// not stop the rest of a file the owner assembled by hand.
type ContactImportResult struct {
	Name string `json:"name"`
	// Created is false for a contact that already existed and only gained
	// aliases.
	Created bool     `json:"created"`
	Aliases int      `json:"aliases"`
	Errors  []string `json:"errors,omitempty"`
}

// ImportContacts applies a batch of contacts and their aliases, reporting each
// one separately. Existing contacts are kept and only extended, so re-applying
// a file the owner has edited adds what is new instead of failing whole.
func (s *Store) ImportContacts(ctx context.Context, in []ContactImport) ([]ContactImportResult, error) {
	out := make([]ContactImportResult, 0, len(in))
	for _, c := range in {
		res := ContactImportResult{Name: strings.TrimSpace(c.Name)}
		_, err := s.GetContact(ctx, res.Name)
		switch {
		case errors.Is(err, ErrNotFound):
			if _, err := s.CreateContact(ctx, res.Name, c.Note); err != nil {
				res.Errors = append(res.Errors, err.Error())
				out = append(out, res)
				continue
			}
			res.Created = true
		case err != nil:
			res.Errors = append(res.Errors, err.Error())
			out = append(out, res)
			continue
		}
		for _, a := range c.Aliases {
			if _, err := s.AddAlias(ctx, res.Name, a.Source, a.Value); err != nil {
				res.Errors = append(res.Errors, fmt.Sprintf("%s: %v", a.Value, err))
				continue
			}
			res.Aliases++
		}
		out = append(out, res)
	}
	return out, nil
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
		`select id, name, note, self, created_at from contacts where name = $1`,
		strings.TrimSpace(cleanText(name))).Scan(&c.ID, &c.Name, &c.Note, &c.Self, &c.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
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
	rows, err := s.pool.Query(ctx, `
		select c.id, c.name, c.note, c.self, c.created_at,
		       a.value is not null, coalesce(a.source, ''), coalesce(a.value, ''), coalesce(a.value_norm, '')
		from contacts c
		left join contact_aliases a on a.contact_id = c.id
		order by c.name, a.source, a.value_norm`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Contact{}
	for rows.Next() {
		var c Contact
		var a ContactAlias
		var hasAlias bool
		if err := rows.Scan(&c.ID, &c.Name, &c.Note, &c.Self, &c.CreatedAt,
			&hasAlias, &a.Source, &a.Value, &a.Normalized); err != nil {
			return nil, err
		}
		if len(out) == 0 || out[len(out)-1].ID != c.ID {
			c.Aliases = []ContactAlias{}
			out = append(out, c)
		}
		if hasAlias {
			out[len(out)-1].Aliases = append(out[len(out)-1].Aliases, a)
		}
	}
	return out, rows.Err()
}

// AddAlias attaches one identity to a contact. Normalization happens in SQL so
// the stored form and the matching form can never drift apart.
func (s *Store) AddAlias(ctx context.Context, name, source, value string) (ContactAlias, error) {
	var a ContactAlias
	value = strings.TrimSpace(cleanText(value))
	if value == "" {
		return a, fail.Invalidf("alias must not be empty")
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
		return a, fail.Invalidf("alias %q normalizes to nothing", value)
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
	if errors.Is(err, pgx.ErrNoRows) {
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
		return fail.Invalidf("contact %q has no alias %q in scope %q", name, value, scopeName(source))
	}
	return nil
}

func scopeName(source string) string {
	if source == "" {
		return "all sources"
	}
	return source
}

// SetSelf marks the contact as the archive's owner, so browse leaves the
// owner's aliases out of a thread's members. One contact at most is the owner.
func (s *Store) SetSelf(ctx context.Context, name string) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `update contacts set self = false where self`); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `update contacts set self = true where name = $1`, strings.TrimSpace(cleanText(name)))
		if err == nil && tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return err
	})
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
	Before ref.Message
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
// first.
func (s *Store) ContactMessages(ctx context.Context, name string, o ContactMessagesOpts) ([]MessageDetail, error) {
	c, err := s.GetContact(ctx, name)
	if err != nil {
		return nil, err
	}
	o.Limit = page.Limit(o.Limit)
	if err := page.Check(o.Limit, o.Offset); err != nil {
		return nil, err
	}
	if !o.Before.IsZero() && o.Offset > 0 {
		return nil, fail.Invalidf("use a before cursor without offset")
	}
	sql := `select ` + messageColumns + ` from messages m where` + aliasMatch("$1")
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
	if !o.Before.IsZero() {
		var id int64
		err := s.pool.QueryRow(ctx, `select m.id from messages m where m.ref=$2 and`+aliasMatch("$1"), c.ID, o.Before.String()).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("before cursor is not a message for this contact")
		}
		if err != nil {
			return nil, err
		}
		anchor := next(id)
		sql += " and (m.sort_at,m.id)<((select sort_at from messages where id=" + anchor + ")," + anchor + ")"
	}
	sql += " order by m.sort_at desc, m.id desc limit " + next(o.Limit)
	if o.Offset > 0 {
		sql += " offset " + next(o.Offset)
	}

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MessageDetail{}
	for rows.Next() {
		var m MessageDetail
		if err := m.scanFull(rows); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := s.loadAttachments(ctx, out); err != nil {
		return nil, err
	}
	return out, nil
}

// The AI chat exports record who spoke as a role, not as a person: every
// ChatGPT and Claude conversation has an "assistant" and a "user". Left in,
// they are the two loudest suggestions in the archive and neither is someone to
// attach a contact to.
var (
	llmRoleSources = []string{"chatgpt", "claude"}
	llmRoles       = []string{"assistant", "user"}
)

// SuggestIdentities ranks the identities no contact claims yet by how much
// mail they account for, so attaching the people who actually matter does not
// start with guessing what the archive calls them.
func (s *Store) SuggestIdentities(ctx context.Context, limit int) ([]IdentitySuggestion, error) {
	limit = page.Limit(limit)
	if err := page.Check(limit, 0); err != nil {
		return nil, err
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
		  and not (source = any ($2::text[]) and identity = any ($3::text[]))
		  and not exists (
			select 1 from contact_aliases a
			where a.value_norm = seen.identity and (a.source = '' or a.source = seen.source))
		group by identity
		order by count(*) desc, identity
		limit $1`, limit, llmRoleSources, llmRoles)
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

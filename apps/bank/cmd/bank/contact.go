package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/server"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// builtinSources are the source names the importers write. Listing them means
// an alias can be scoped to a source before anything from it exists, and that
// "whatsapp:Alice" is read as a scope rather than as a name with a colon in it.
var builtinSources = []string{
	"whatsapp", "gmail", "proton", "discord", "linkedin", "youtube", "chatgpt", "claude",
}

type contactCmd struct {
	Add      contactAddCmd      `cmd:"" help:"Create a contact."`
	Rm       contactRmCmd       `cmd:"" aliases:"remove,delete" help:"Remove a contact; its messages are untouched."`
	List     contactListCmd     `cmd:"" aliases:"ls" help:"Contacts and their identities."`
	Show     contactShowCmd     `cmd:"" help:"One contact, its identities and message counts."`
	Alias    contactAliasCmd    `cmd:"" help:"Attach or detach identities."`
	Messages contactMessagesCmd `cmd:"" help:"Everything a contact sent or received, newest first."`
	Suggest  contactSuggestCmd  `cmd:"" help:"Identities no contact claims yet."`
	Import   contactImportCmd   `cmd:"" help:"Apply a whole contact book at once."`
	Self     contactSelfCmd     `cmd:"" help:"Mark the contact that is you, whom browse leaves out of thread members."`
}

func (contactCmd) Help() string {
	return `An alias is an identity that means this person: an email address, a WhatsApp
display name, a Discord handle. It matches everywhere by default; write it as
"<source>:<value>" to bind it to one source.

import takes a JSON array or NDJSON of
{"name": "...", "note": "...", "aliases": ["whatsapp:...", "a@example.com"]}.`
}

type contactAddCmd struct {
	Name string `arg:""`
	Note string `help:"Free-text note."`
}

func (c *contactAddCmd) Run(ctx context.Context) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	contact, err := client.Call(ctx, api, server.CreateContact, server.ContactCreateInput{Body: server.ContactCreateInputBody{Name: c.Name, Note: c.Note}})
	if err != nil {
		return err
	}
	fmt.Printf("contact %s\nattach identities with: bank contact alias add %s <email|handle>\n", contact.Name, contact.Name)
	return nil
}

type contactRmCmd struct {
	Name string `arg:""`
}

func (c *contactRmCmd) Run(ctx context.Context) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	if _, err := client.Call(ctx, api, server.DeleteContact, server.ContactInput{Name: c.Name}); err != nil {
		return contactErr(c.Name, err)
	}
	// Worth saying plainly: this is a lens, not the data.
	fmt.Printf("contact %s removed; its messages are untouched\n", c.Name)
	return nil
}

type contactSelfCmd struct {
	Name string `arg:""`
}

func (c *contactSelfCmd) Run(ctx context.Context) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	if _, err := client.Call(ctx, api, server.SetSelfContact, server.ContactInput{Name: c.Name}); err != nil {
		return contactErr(c.Name, err)
	}
	fmt.Printf("contact %s is the archive's owner\n", c.Name)
	return nil
}

type contactListCmd struct {
	JSON bool `help:"JSON output."`
}

func (c *contactListCmd) Run(ctx context.Context) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	contacts, err := client.Call(ctx, api, server.ListContacts, struct{}{})
	if err != nil {
		return err
	}
	if c.JSON {
		return printJSON(contacts)
	}
	if len(contacts) == 0 {
		fmt.Println("no contacts yet — 'bank contact suggest' shows who is in the archive")
		return nil
	}
	for _, contact := range contacts {
		fmt.Printf("%-20s %s\n", contact.Name, strings.Join(aliasStrings(contact.Aliases), ", "))
		if contact.Note != "" {
			fmt.Printf("%-20s %s\n", "", contact.Note)
		}
	}
	return nil
}

func aliasStrings(aliases []store.ContactAlias) []string {
	out := make([]string, len(aliases))
	for i, a := range aliases {
		out[i] = a.Normalized
		if a.Source != "" {
			out[i] = a.Source + ":" + a.Normalized
		}
	}
	return out
}

type contactShowCmd struct {
	Name string `arg:""`
	JSON bool   `help:"JSON output."`
}

func (c *contactShowCmd) Run(ctx context.Context) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	d, err := client.Call(ctx, api, server.GetContact, server.ContactInput{Name: c.Name})
	if err != nil {
		return contactErr(c.Name, err)
	}
	if c.JSON {
		return printJSON(d)
	}
	fmt.Printf("contact: %s\n", d.Name)
	if d.Note != "" {
		fmt.Printf("note:    %s\n", d.Note)
	}
	fmt.Println("aliases:")
	for _, a := range d.Aliases {
		fmt.Printf("  %-28s %s\n", a.Normalized, scopeLabel(a.Source))
	}
	if len(d.Aliases) == 0 {
		fmt.Println("  (none yet — nothing will match until one is attached)")
	}
	var total int64
	fmt.Println("messages:")
	for _, s := range d.Sources {
		fmt.Printf("  %-12s %8d\n", s.Source, s.Messages)
		total += s.Messages
	}
	fmt.Printf("  %-12s %8d\n", "total", total)
	return nil
}

func scopeLabel(source string) string {
	if source == "" {
		return "(all sources)"
	}
	return "(" + source + " only)"
}

type contactAliasCmd struct {
	Add contactAliasAddCmd `cmd:"" help:"Attach identities to a contact."`
	Rm  contactAliasRmCmd  `cmd:"" aliases:"remove" help:"Detach identities from a contact."`
}

type contactAliasAddCmd struct {
	Name    string   `arg:""`
	Aliases []string `arg:"" name:"alias"`
}

func (c *contactAliasAddCmd) Run(ctx context.Context) error {
	return eachAlias(ctx, c.Aliases, func(api *client.Client, source, value string) error {
		a, err := client.Call(ctx, api, server.AddContactAlias, server.AliasAddInput{Name: c.Name, Body: server.AliasAddInputBody{Source: source, Value: value}})
		if err != nil {
			return contactErr(c.Name, err)
		}
		fmt.Printf("%s: %s %s\n", c.Name, a.Normalized, scopeLabel(a.Source))
		return nil
	})
}

type contactAliasRmCmd struct {
	Name    string   `arg:""`
	Aliases []string `arg:"" name:"alias"`
}

func (c *contactAliasRmCmd) Run(ctx context.Context) error {
	return eachAlias(ctx, c.Aliases, func(api *client.Client, source, value string) error {
		if _, err := client.Call(ctx, api, server.RemoveContactAlias, server.AliasRemoveInput{Name: c.Name, Source: source, Value: value}); err != nil {
			return contactErr(c.Name, err)
		}
		fmt.Printf("%s: detached %s %s\n", c.Name, value, scopeLabel(source))
		return nil
	})
}

func eachAlias(ctx context.Context, aliases []string, apply func(api *client.Client, source, value string) error) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	known, err := knownSources(ctx, api)
	if err != nil {
		return err
	}
	for _, raw := range aliases {
		source, value := store.ContactAliasScope(raw, func(s string) bool { return known[s] })
		if err := apply(api, source, value); err != nil {
			return err
		}
	}
	return nil
}

// knownSources is what makes "whatsapp:Alice" a scope rather than a value: the
// sources already in the archive, plus the ones importers can still create.
func knownSources(ctx context.Context, api *client.Client) (map[string]bool, error) {
	out := map[string]bool{}
	for _, s := range builtinSources {
		out[s] = true
	}
	stats, err := client.Call(ctx, api, server.GetStats, struct{}{})
	if err != nil {
		return nil, err
	}
	for _, s := range stats {
		out[s.Source] = true
	}
	return out, nil
}

type contactMessagesCmd struct {
	Name   string      `arg:""`
	Source string      `help:"Only this source."`
	Since  string      `help:"YYYY-MM-DD."`
	Until  string      `help:"YYYY-MM-DD (exclusive)."`
	Limit  int         `default:"${limit}" help:"Page size, 1-${max_limit}."`
	Before ref.Message `help:"Continue before this message, by ref (without --offset)."`
	Offset int         `help:"Skip this many messages, at most ${max_offset}."`
	JSON   bool        `help:"JSON output."`
}

func (c *contactMessagesCmd) Run(ctx context.Context) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	msgs, err := client.Call(ctx, api, server.ListContactMessages, server.ContactMessagesInput{Name: c.Name, Source: c.Source,
		Since: c.Since, Until: c.Until, Before: c.Before, Page: pageOf(c.Limit, c.Offset)})
	if err != nil {
		return contactErr(c.Name, err)
	}
	if c.JSON {
		return printJSON(msgs)
	}
	if len(msgs) == 0 {
		fmt.Println("no messages — check 'bank contact show' that an alias actually matches")
		return nil
	}
	for _, m := range msgs {
		title := m.Subject
		if title == "" {
			title = excerpt(m.Body, 100)
		}
		fmt.Printf("%s  %s  %-8s  %-22s  %s\n",
			m.Ref, formatSent(m.SentAt, "2006-01-02"), m.Source, excerpt(m.Sender, 22), title)
	}
	if len(msgs) == c.Limit {
		fmt.Printf("Earlier messages: repeat with --before %s and without --offset\n", msgs[len(msgs)-1].Ref)
	}
	return nil
}

type contactSuggestCmd struct {
	Limit int  `default:"${limit}" help:"How many identities, 1-${max_limit}."`
	JSON  bool `help:"JSON output."`
}

func (c *contactSuggestCmd) Run(ctx context.Context) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	out, err := client.Call(ctx, api, server.SuggestContacts, server.ContactSuggestInput{PageSize: httpapi.PageSize{Limit: c.Limit}})
	if err != nil {
		return err
	}
	if c.JSON {
		return printJSON(out)
	}
	if len(out) == 0 {
		fmt.Println("every identity in the archive is already attached to a contact")
		return nil
	}
	fmt.Println("identities no contact claims yet, most talkative first:")
	for _, s := range out {
		fmt.Printf("%8d  %-40s %s\n", s.Messages, excerpt(s.Identity, 40), strings.Join(s.Sources, ", "))
	}
	fmt.Println("\nattach one with: bank contact alias add <name> <identity>")
	return nil
}

// contactEntry is the import file's shape. Aliases are written the way the
// alias command takes them ("whatsapp:Alice", "alice@example.com") and are
// resolved against the known sources here, so the file needs no scope field.
type contactEntry struct {
	Name    string   `json:"name"`
	Note    string   `json:"note"`
	Aliases []string `json:"aliases"`
}

// contactImportCmd applies a whole contact book at once — the practical way
// to turn an address-book export into contacts, one identity per line, instead
// of a shell loop over `contact add` and `contact alias add`. Conflicts are
// reported and skipped: the file is the owner's, and one alias another contact
// already claims must not cost the rest of it.
type contactImportCmd struct {
	File string `arg:"" help:"JSON array or NDJSON; - reads stdin."`
	JSON bool   `help:"JSON output."`
}

func (c *contactImportCmd) Run(ctx context.Context) error {
	input, err := readInput(c.File)
	if err != nil {
		return err
	}
	entries, err := decodeJSONEntries[contactEntry](input)
	if err != nil {
		return fmt.Errorf("%s: %w", c.File, err)
	}
	if len(entries) == 0 {
		return fmt.Errorf("%s holds no contacts", c.File)
	}
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	known, err := knownSources(ctx, api)
	if err != nil {
		return err
	}
	in := make([]store.ContactImport, 0, len(entries))
	for _, e := range entries {
		contact := store.ContactImport{Name: e.Name, Note: e.Note}
		for _, raw := range e.Aliases {
			source, value := store.ContactAliasScope(raw, func(s string) bool { return known[s] })
			contact.Aliases = append(contact.Aliases, store.ImportedAlias{Source: source, Value: value})
		}
		in = append(in, contact)
	}

	res, err := client.Call(ctx, api, server.ImportContacts, server.ContactImportInput{Body: in})
	if err != nil {
		return err
	}
	if c.JSON {
		return printJSON(res)
	}
	var created, aliases, failed int
	for _, r := range res {
		state := "existing"
		if r.Created {
			state = "created"
			created++
		}
		aliases += r.Aliases
		fmt.Printf("%-20s %-8s %d aliases\n", r.Name, state, r.Aliases)
		for _, e := range r.Errors {
			failed++
			fmt.Fprintf(os.Stderr, "bank: %s: %s\n", r.Name, e)
		}
	}
	fmt.Printf("%d contacts (%d created), %d aliases attached", len(res), created, aliases)
	if failed > 0 {
		fmt.Printf(", %d skipped", failed)
	}
	fmt.Println()
	return nil
}

// decodeJSONEntries reads a JSON array or a stream of newline-delimited
// objects, the same two shapes `bank import json` accepts.
func decodeJSONEntries[T any](input []byte) ([]T, error) {
	dec := json.NewDecoder(bytes.NewReader(input))
	tok, err := dec.Token()
	if errors.Is(err, io.EOF) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '[' {
		dec = json.NewDecoder(bytes.NewReader(input)) // not an array: a stream of objects
	}
	var out []T
	for dec.More() {
		var v T
		if err := dec.Decode(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

// contactErr turns the store's not-found sentinel into a message that names
// what was actually missing.
func contactErr(name string, err error) error {
	if errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("no contact %q — see 'bank contact list'", name)
	}
	return err
}

// readInput reads a file, or stdin when path is "-".
func readInput(path string) ([]byte, error) {
	if path == "-" {
		return io.ReadAll(os.Stdin)
	}
	return os.ReadFile(path)
}

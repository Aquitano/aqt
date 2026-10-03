package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// builtinSources are the source names the importers write. Listing them means
// an alias can be scoped to a source before anything from it exists, and that
// "whatsapp:Alice" is read as a scope rather than as a name with a colon in it.
var builtinSources = []string{
	"whatsapp", "gmail", "proton", "discord", "linkedin", "youtube", "chatgpt", "claude",
}

const contactUsage = `usage: bank contact <add|rm|list|show|alias|messages|suggest|import> ...

  bank contact add <name> [--note text]
  bank contact rm <name>
  bank contact list [--json]
  bank contact show <name> [--json]
  bank contact alias add <name> <alias>...
  bank contact alias rm <name> <alias>...
  bank contact messages <name> [--source s] [--since d] [--until d] [--limit n] [--json]
  bank contact suggest [--limit n] [--json]
  bank contact import <file|-> [--json]

An alias is an identity that means this person: an email address, a WhatsApp
display name, a Discord handle. It matches everywhere by default; write it as
"<source>:<value>" to bind it to one source.

import takes a JSON array or NDJSON of
{"name": "...", "note": "...", "aliases": ["whatsapp:...", "a@example.com"]}.`

func cmdContact(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New(contactUsage)
	}
	b, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()

	switch args[0] {
	case "add":
		return contactAdd(ctx, b, args[1:])
	case "rm", "remove", "delete":
		return contactRemove(ctx, b, args[1:])
	case "list", "ls":
		return contactList(ctx, b, args[1:])
	case "show":
		return contactShow(ctx, b, args[1:])
	case "alias":
		return contactAlias(ctx, b, args[1:])
	case "messages":
		return contactMessages(ctx, b, args[1:])
	case "suggest":
		return contactSuggest(ctx, b, args[1:])
	case "import":
		return contactImport(ctx, b, args[1:])
	}
	return fmt.Errorf("unknown contact command %q\n\n%s", args[0], contactUsage)
}

func contactAdd(ctx context.Context, b backend, args []string) error {
	fs := flag.NewFlagSet("contact add", flag.ExitOnError)
	note := fs.String("note", "", "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: bank contact add <name> [--note text]")
	}
	c, err := b.CreateContact(ctx, fs.Arg(0), *note)
	if err != nil {
		return err
	}
	fmt.Printf("contact %s\nattach identities with: bank contact alias add %s <email|handle>\n", c.Name, c.Name)
	return nil
}

func contactRemove(ctx context.Context, b backend, args []string) error {
	if len(args) != 1 {
		return errors.New("usage: bank contact rm <name>")
	}
	if err := b.DeleteContact(ctx, args[0]); err != nil {
		return contactErr(args[0], err)
	}
	// Worth saying plainly: this is a lens, not the data.
	fmt.Printf("contact %s removed; its messages are untouched\n", args[0])
	return nil
}

func contactList(ctx context.Context, b backend, args []string) error {
	fs := flag.NewFlagSet("contact list", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	contacts, err := b.ListContacts(ctx)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(contacts)
	}
	if len(contacts) == 0 {
		fmt.Println("no contacts yet — 'bank contact suggest' shows who is in the archive")
		return nil
	}
	for _, c := range contacts {
		fmt.Printf("%-20s %s\n", c.Name, strings.Join(aliasStrings(c.Aliases), ", "))
		if c.Note != "" {
			fmt.Printf("%-20s %s\n", "", c.Note)
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

func contactShow(ctx context.Context, b backend, args []string) error {
	fs := flag.NewFlagSet("contact show", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: bank contact show <name> [--json]")
	}
	d, err := b.GetContactDetail(ctx, fs.Arg(0))
	if err != nil {
		return contactErr(fs.Arg(0), err)
	}
	if *asJSON {
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

func contactAlias(ctx context.Context, b backend, args []string) error {
	if len(args) < 3 {
		return errors.New("usage: bank contact alias <add|rm> <name> <alias>...")
	}
	action, name, aliases := args[0], args[1], args[2:]
	known, err := knownSources(ctx, b)
	if err != nil {
		return err
	}
	for _, raw := range aliases {
		source, value := store.ContactAliasScope(raw, func(s string) bool { return known[s] })
		switch action {
		case "add":
			a, err := b.AddAlias(ctx, name, source, value)
			if err != nil {
				return contactErr(name, err)
			}
			fmt.Printf("%s: %s %s\n", name, a.Normalized, scopeLabel(a.Source))
		case "rm", "remove":
			if err := b.RemoveAlias(ctx, name, source, value); err != nil {
				return contactErr(name, err)
			}
			fmt.Printf("%s: detached %s %s\n", name, value, scopeLabel(source))
		default:
			return fmt.Errorf("unknown alias command %q (add, rm)", action)
		}
	}
	return nil
}

// knownSources is what makes "whatsapp:Alice" a scope rather than a value: the
// sources already in the archive, plus the ones importers can still create.
func knownSources(ctx context.Context, b backend) (map[string]bool, error) {
	out := map[string]bool{}
	for _, s := range builtinSources {
		out[s] = true
	}
	stats, err := b.Stats(ctx)
	if err != nil {
		return nil, err
	}
	for _, s := range stats {
		out[s.Source] = true
	}
	return out, nil
}

func contactMessages(ctx context.Context, b backend, args []string) error {
	fs := flag.NewFlagSet("contact messages", flag.ExitOnError)
	var o store.ContactMessagesOpts
	var since, until string
	var asJSON bool
	fs.StringVar(&o.Source, "source", "", "")
	fs.StringVar(&since, "since", "", "")
	fs.StringVar(&until, "until", "", "")
	fs.IntVar(&o.Limit, "limit", 50, "")
	fs.Int64Var(&o.Before, "before", 0, "")
	fs.IntVar(&o.Offset, "offset", 0, "")
	fs.BoolVar(&asJSON, "json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: bank contact messages <name> [flags]")
	}
	var err error
	if o.Since, err = parseDate(since); err != nil {
		return err
	}
	if o.Until, err = parseDate(until); err != nil {
		return err
	}
	msgs, err := b.ContactMessages(ctx, fs.Arg(0), o)
	if err != nil {
		return contactErr(fs.Arg(0), err)
	}
	if asJSON {
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
		fmt.Printf("%6d  %s  %-8s  %-22s  %s\n",
			m.ID, m.SentAt.Format("2006-01-02"), m.Source, excerpt(m.Sender, 22), title)
	}
	if len(msgs) == o.Limit {
		fmt.Printf("Earlier messages: repeat with --before %d and without --offset\n", msgs[len(msgs)-1].ID)
	}
	return nil
}

func contactSuggest(ctx context.Context, b backend, args []string) error {
	fs := flag.NewFlagSet("contact suggest", flag.ExitOnError)
	limit := fs.Int("limit", 20, "")
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	out, err := b.SuggestIdentities(ctx, *limit)
	if err != nil {
		return err
	}
	if *asJSON {
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

// contactImport applies a whole contact book at once — the practical way to
// turn an address-book export into contacts, one identity per line, instead of
// a shell loop over `contact add` and `contact alias add`. Conflicts are
// reported and skipped: the file is the owner's, and one alias another contact
// already claims must not cost the rest of it.
func contactImport(ctx context.Context, b backend, args []string) error {
	fs := flag.NewFlagSet("contact import", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: bank contact import <file|-> [--json]")
	}
	input, err := readInput(fs.Arg(0))
	if err != nil {
		return err
	}
	entries, err := decodeJSONEntries[contactEntry](input)
	if err != nil {
		return fmt.Errorf("%s: %w", fs.Arg(0), err)
	}
	if len(entries) == 0 {
		return fmt.Errorf("%s holds no contacts", fs.Arg(0))
	}
	known, err := knownSources(ctx, b)
	if err != nil {
		return err
	}
	in := make([]store.ContactImport, 0, len(entries))
	for _, e := range entries {
		c := store.ContactImport{Name: e.Name, Note: e.Note}
		for _, raw := range e.Aliases {
			source, value := store.ContactAliasScope(raw, func(s string) bool { return known[s] })
			c.Aliases = append(c.Aliases, store.ImportedAlias{Source: source, Value: value})
		}
		in = append(in, c)
	}

	res, err := b.ImportContacts(ctx, in)
	if err != nil {
		return err
	}
	if *asJSON {
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

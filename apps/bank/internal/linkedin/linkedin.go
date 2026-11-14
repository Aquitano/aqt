// Package linkedin imports messages.csv from the official LinkedIn data
// export ("Get a copy of your data"), given as the csv, the export zip, or an
// unpacked export directory.
package linkedin

import (
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/export"
	"github.com/aquitano/aqt/apps/bank/internal/fieldhash"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
)

type Source struct{}

type Options struct{}

func (Source) Kind() string { return "linkedin" }

type message struct {
	ConversationID string
	Title          string
	Thread         string
	From           string
	To             string
	Subject        string
	Body           string
	SentAt         time.Time
}

func (Source) Parse(ctx context.Context, raw ingest.Raw, _ Options, out ingest.Emitter) error {
	msgs, err := readMessages(raw)
	if err != nil {
		return err
	}
	for i, m := range msgs {
		locator := fmt.Sprintf("row %d", i+1)
		if m.Body == "" && m.Subject == "" {
			out.Issue(ingest.Issuef(ingest.Skipped, "%s: no subject and no content", locator))
			continue
		}
		var recipients []string
		if m.To != "" {
			recipients = []string{m.To}
		}
		subject := m.Subject
		if subject == "" {
			subject = m.Title
		}
		if err := out.Message(ingest.Message{
			Source:     "linkedin",
			ExternalID: externalID(m),
			ThreadID:   m.Thread,
			Sender:     m.From,
			Recipients: recipients,
			Subject:    subject,
			Body:       m.Body,
			SentAt:     m.SentAt,
			Locator:    locator,
		}); err != nil {
			return err
		}
	}
	return nil
}

func externalID(m message) string {
	var date string
	if !m.SentAt.IsZero() {
		date = m.SentAt.UTC().Format(time.RFC3339)
	}
	return fieldhash.Hex(m.ConversationID, date, m.From, m.Body)
}

// readMessages parses messages.csv out of the export zip or the CSV itself.
func readMessages(raw ingest.Raw) ([]message, error) {
	exp, err := export.Open(raw)
	if err != nil {
		return nil, err
	}
	defer exp.Close()
	var f io.ReadCloser
	if exp.FS == nil {
		f, err = raw.Open()
	} else if name, findErr := findMessagesCSV(exp.FS); findErr != nil {
		err = fmt.Errorf("%s: %w", raw.Name, findErr)
	} else {
		f, err = exp.FS.Open(name)
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return parseCSV(f)
}

func findMessagesCSV(fsys fs.FS) (string, error) {
	if _, err := fs.Stat(fsys, "messages.csv"); err == nil {
		return "messages.csv", nil
	}
	found := ""
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			// An unreadable directory elsewhere in the export must not abort the search.
			if p == "." {
				return err
			}
			return nil
		}
		if d.IsDir() || !strings.EqualFold(path.Base(p), "messages.csv") {
			return nil
		}
		found = p
		return fs.SkipAll
	})
	if err == nil && found == "" {
		err = errors.New("no messages.csv in export")
	}
	return found, err
}

func parseCSV(r io.Reader) ([]message, error) {
	cr := csv.NewReader(r)
	cr.LazyQuotes = true
	cr.FieldsPerRecord = -1
	header, err := cr.Read()
	if err != nil {
		return nil, err
	}
	// A UTF-8 BOM sticks to the first header cell and is not whitespace: left
	// alone it renames CONVERSATION ID and merges distinct conversations.
	header[0] = strings.TrimPrefix(header[0], "\ufeff")
	col := map[string]int{}
	for i, h := range header {
		col[strings.ToUpper(strings.TrimSpace(h))] = i
	}
	get := func(rec []string, name string) string {
		i, ok := col[name]
		if !ok || i >= len(rec) {
			return ""
		}
		return strings.TrimSpace(rec[i])
	}
	var out []message
	for {
		rec, err := cr.Read()
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		m := message{
			ConversationID: get(rec, "CONVERSATION ID"),
			Thread:         get(rec, "CONVERSATION ID"),
			Title:          get(rec, "CONVERSATION TITLE"),
			From:           get(rec, "FROM"),
			To:             get(rec, "TO"),
			Subject:        get(rec, "SUBJECT"),
			Body:           get(rec, "CONTENT"),
			SentAt:         parseDate(get(rec, "DATE")),
		}
		if m.Thread == "" {
			m.Thread = get(rec, "CONVERSATION TITLE")
		}
		out = append(out, m)
	}
}

// parseDate reads the abbreviation layout's wall clock as UTC, which is what
// LinkedIn writes. time.Parse would resolve any other abbreviation against the
// machine's zone when that zone knows it, making the instant, and the external
// id hashed from it, depend on where the import runs.
func parseDate(s string) time.Time {
	if t, err := time.Parse("2006-01-02 15:04:05 MST", s); err == nil {
		return time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), time.UTC)
	}
	for _, layout := range []string{"2006-01-02 15:04:05", time.RFC3339} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

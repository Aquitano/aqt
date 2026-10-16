// Package linkedin imports messages.csv from the official LinkedIn data
// export ("Get a copy of your data"), given as the csv, the export zip, or an
// unpacked export directory.
package linkedin

import (
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/export"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

type Result struct {
	Inserted   int `json:"inserted"`
	Duplicates int `json:"duplicates"`
	Skipped    int `json:"skipped"`
}

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

func Import(ctx context.Context, st *store.Store, archiveDir, inputPath string) (Result, error) {
	var res Result

	msgs, rawRef, err := readMessages(archiveDir, inputPath)
	if err != nil {
		return res, err
	}
	messages := make([]store.Message, 0, len(msgs))
	for _, m := range msgs {
		if m.Body == "" && m.Subject == "" {
			res.Skipped++
			continue
		}
		sum := sha256.Sum256([]byte(m.ConversationID + "\x00" + m.SentAt.UTC().Format(time.RFC3339) + "\x00" + m.From + "\x00" + m.Body))
		var recipients []string
		if m.To != "" {
			recipients = []string{m.To}
		}
		subject := m.Subject
		if subject == "" {
			subject = m.Title
		}
		messages = append(messages, store.Message{
			Source:     "linkedin",
			ExternalID: hex.EncodeToString(sum[:]),
			ThreadID:   m.Thread,
			Sender:     m.From,
			Recipients: recipients,
			Subject:    subject,
			Body:       m.Body,
			SentAt:     m.SentAt,
			RawRef:     rawRef,
		})
	}
	ids, err := st.InsertMessages(ctx, messages, store.InsertMessagesOpts{Rethread: true})
	if err != nil {
		return res, fail.Opf("insert messages: %w", err)
	}
	for _, id := range ids {
		if id == 0 {
			res.Duplicates++
		} else {
			res.Inserted++
		}
	}
	return res, nil
}

// readMessages archives the raw input, then parses messages.csv out of the
// export zip, its unpacked directory, or the CSV itself.
func readMessages(archiveDir, inputPath string) ([]message, string, error) {
	exp, err := export.Open(inputPath)
	if err != nil {
		return nil, "", err
	}
	defer exp.Close()
	archived := inputPath
	var f io.ReadCloser
	if exp.FS == nil {
		f, err = os.Open(inputPath)
	} else if name, findErr := findMessagesCSV(exp.FS); findErr != nil {
		err = fmt.Errorf("%s: %w", inputPath, findErr)
	} else {
		f, err = exp.FS.Open(name)
		if exp.Dir {
			archived = filepath.Join(inputPath, filepath.FromSlash(name))
		}
	}
	if err != nil {
		return nil, "", err
	}
	defer f.Close()
	rawRef, err := archive.Copy(archiveDir, "linkedin", archived)
	if err != nil {
		return nil, "", fail.Opf("archive %s: %w", archived, err)
	}
	msgs, err := parseCSV(f)
	return msgs, rawRef, err
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

func parseDate(s string) time.Time {
	for _, layout := range []string{"2006-01-02 15:04:05 MST", "2006-01-02 15:04:05", time.RFC3339} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Unix(0, 0)
}

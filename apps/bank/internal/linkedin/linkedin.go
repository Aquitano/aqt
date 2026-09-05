// Package linkedin imports messages.csv from the official LinkedIn data
// export ("Get a copy of your data"), given as the csv, the export zip, or an
// unpacked export directory.
package linkedin

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
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
	Thread         string
	From           string
	To             string
	Subject        string
	Body           string
	SentAt         time.Time
}

func Import(ctx context.Context, st *store.Store, archiveDir, inputPath string) (Result, error) {
	var res Result

	open, rawRef, cleanup, err := openMessagesCSV(archiveDir, inputPath)
	if err != nil {
		return res, err
	}
	defer cleanup()

	msgs, err := parseCSV(open)
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
		messages = append(messages, store.Message{
			Source:     "linkedin",
			ExternalID: hex.EncodeToString(sum[:]),
			ThreadID:   m.Thread,
			Sender:     m.From,
			Recipients: recipients,
			Subject:    m.Subject,
			Body:       m.Body,
			SentAt:     m.SentAt,
			RawRef:     rawRef,
		})
	}
	ids, err := st.InsertMessages(ctx, messages, store.InsertMessagesOpts{})
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

func openMessagesCSV(archiveDir, inputPath string) (io.Reader, string, func(), error) {
	noop := func() {}
	info, err := os.Stat(inputPath)
	if err != nil {
		return nil, "", noop, err
	}
	switch {
	case info.IsDir():
		p := filepath.Join(inputPath, "messages.csv")
		f, err := os.Open(p)
		if err != nil {
			return nil, "", noop, err
		}
		rawRef, err := archive.Copy(archiveDir, "linkedin", p)
		if err != nil {
			f.Close()
			return nil, "", noop, fail.Opf("archive %s: %w", p, err)
		}
		return f, rawRef, func() { f.Close() }, nil
	case strings.EqualFold(filepath.Ext(inputPath), ".zip"):
		zr, err := zip.OpenReader(inputPath)
		if err != nil {
			return nil, "", noop, err
		}
		for _, f := range zr.File {
			if strings.EqualFold(filepath.Base(f.Name), "messages.csv") {
				rc, err := f.Open()
				if err != nil {
					zr.Close()
					return nil, "", noop, err
				}
				rawRef, err := archive.Copy(archiveDir, "linkedin", inputPath)
				if err != nil {
					rc.Close()
					zr.Close()
					return nil, "", noop, fail.Opf("archive %s: %w", inputPath, err)
				}
				return rc, rawRef, func() { rc.Close(); zr.Close() }, nil
			}
		}
		zr.Close()
		return nil, "", noop, fmt.Errorf("%s: no messages.csv in export zip", inputPath)
	default:
		f, err := os.Open(inputPath)
		if err != nil {
			return nil, "", noop, err
		}
		rawRef, err := archive.Copy(archiveDir, "linkedin", inputPath)
		if err != nil {
			f.Close()
			return nil, "", noop, fail.Opf("archive %s: %w", inputPath, err)
		}
		return f, rawRef, func() { f.Close() }, nil
	}
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
			Thread:         get(rec, "CONVERSATION TITLE"),
			From:           get(rec, "FROM"),
			To:             get(rec, "TO"),
			Subject:        get(rec, "SUBJECT"),
			Body:           get(rec, "CONTENT"),
			SentAt:         parseDate(get(rec, "DATE")),
		}
		if m.Thread == "" {
			m.Thread = m.ConversationID
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

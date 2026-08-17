// Package generic imports arbitrary messages from JSON, the escape hatch for
// agents and one-off sources. Input is either a JSON array or newline-delimited
// objects:
//
//	{"source": "notes", "body": "...", "sent_at": "2024-05-13T21:08:00Z",
//	 "thread": "...", "sender": "...", "recipients": ["..."], "subject": "...",
//	 "external_id": "...", "attachments": [{"path": "/tmp/report.pdf"}]}
//
// Only body (or subject) is required; source can come from --source. Omitted
// external_id falls back to a content hash, omitted sent_at to import time.
// Attachment paths are read from local disk into the blob store.
package generic

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/aquitano/aqt-bank/internal/blob"
	"github.com/aquitano/aqt-bank/internal/store"
)

type Result struct {
	Inserted    int `json:"inserted"`
	Duplicates  int `json:"duplicates"`
	Attachments int `json:"attachments"`
	Failed      int `json:"failed"`
}

type entry struct {
	Source      string          `json:"source"`
	ExternalID  string          `json:"external_id"`
	Thread      string          `json:"thread"`
	Sender      string          `json:"sender"`
	Recipients  []string        `json:"recipients"`
	Subject     string          `json:"subject"`
	Body        string          `json:"body"`
	SentAt      json.RawMessage `json:"sent_at"`
	Attachments []struct {
		Path     string `json:"path"`
		Filename string `json:"filename"`
	} `json:"attachments"`
}

func Import(ctx context.Context, st *store.Store, blobs *blob.Store, defaultSource, rawRef string, input []byte, now time.Time) (Result, error) {
	var res Result
	entries, err := parseEntries(input)
	if err != nil {
		return res, err
	}
	seen := map[string]int{}
	for i, e := range entries {
		if e.Source == "" {
			e.Source = defaultSource
		}
		if err := validate(e); err != nil {
			res.Failed++
			fmt.Fprintf(os.Stderr, "bank: json entry %d: %v\n", i, err)
			continue
		}
		sentAt, err := parseSentAt(e.SentAt)
		if err != nil {
			res.Failed++
			fmt.Fprintf(os.Stderr, "bank: json entry %d: %v\n", i, err)
			continue
		}
		externalID := e.ExternalID
		if externalID == "" {
			externalID = derivedID(e, sentAt, seen)
		}
		if sentAt.IsZero() {
			sentAt = now
		}
		id, err := st.InsertMessage(ctx, store.Message{
			Source:     e.Source,
			ExternalID: externalID,
			ThreadID:   e.Thread,
			Sender:     e.Sender,
			Recipients: e.Recipients,
			Subject:    e.Subject,
			Body:       e.Body,
			SentAt:     sentAt,
			RawRef:     rawRef,
		})
		if err != nil {
			return res, err
		}
		if id == 0 {
			res.Duplicates++
			continue
		}
		res.Inserted++
		for _, a := range e.Attachments {
			f, err := os.Open(a.Path)
			if err != nil {
				res.Failed++
				fmt.Fprintf(os.Stderr, "bank: json entry %d attachment: %v\n", i, err)
				continue
			}
			sum, size, err := blobs.Put(f)
			f.Close()
			if err != nil {
				return res, err
			}
			name := a.Filename
			if name == "" {
				name = filepath.Base(a.Path)
			}
			err = st.InsertAttachment(ctx, store.Attachment{
				MessageID: id,
				Filename:  name,
				MimeType:  mime.TypeByExtension(filepath.Ext(name)),
				SizeBytes: size,
				SHA256:    sum,
			})
			if err != nil {
				return res, err
			}
			res.Attachments++
		}
	}
	return res, nil
}

// derivedID hashes only fields the caller controls — never the import time,
// which would make every re-import a duplicate. Entries without sent_at that
// are otherwise identical get an occurrence counter within the batch, so a
// file listing the same note twice keeps both while re-imports stay no-ops.
func derivedID(e entry, sentAt time.Time, seen map[string]int) string {
	timeKey := ""
	if !sentAt.IsZero() {
		timeKey = sentAt.UTC().Format(time.RFC3339Nano)
	}
	base := e.Source + "\x00" + e.Thread + "\x00" + timeKey + "\x00" + e.Sender + "\x00" + e.Subject + "\x00" + e.Body
	n := seen[base]
	seen[base] = n + 1
	if n > 0 {
		base += fmt.Sprintf("\x00%d", n)
	}
	sum := sha256.Sum256([]byte(base))
	return hex.EncodeToString(sum[:])
}

func validate(e entry) error {
	if e.Source == "" {
		return fmt.Errorf(`missing "source" (or pass --source)`)
	}
	if e.Body == "" && e.Subject == "" {
		return fmt.Errorf(`missing "body"`)
	}
	return nil
}

// parseEntries accepts a JSON array, a single object, or a stream of
// whitespace/newline-delimited objects (NDJSON).
func parseEntries(input []byte) ([]entry, error) {
	dec := json.NewDecoder(bytes.NewReader(input))
	dec.UseNumber()
	tok, err := dec.Token()
	if err == io.EOF {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); ok && d == '[' {
		var out []entry
		for dec.More() {
			var e entry
			if err := dec.Decode(&e); err != nil {
				return nil, err
			}
			out = append(out, e)
		}
		return out, nil
	}
	// Not an array: restart and decode a stream of objects.
	dec = json.NewDecoder(bytes.NewReader(input))
	var out []entry
	for {
		var e entry
		if err := dec.Decode(&e); err == io.EOF {
			return out, nil
		} else if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
}

// parseSentAt accepts RFC 3339, "2006-01-02 15:04:05", "2006-01-02" (all as
// JSON strings) or a unix-seconds number. Missing/null means "now".
func parseSentAt(raw json.RawMessage) (time.Time, error) {
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return time.Time{}, nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05", "2006-01-02"} {
			if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
				return t, nil
			}
		}
		return time.Time{}, fmt.Errorf("unparseable sent_at %q", s)
	}
	var n json.Number
	if err := json.Unmarshal(raw, &n); err == nil {
		secs, err := strconv.ParseInt(n.String(), 10, 64)
		if err != nil {
			return time.Time{}, fmt.Errorf("unparseable sent_at %s", n)
		}
		return time.Unix(secs, 0), nil
	}
	return time.Time{}, fmt.Errorf("sent_at must be a string or unix seconds")
}

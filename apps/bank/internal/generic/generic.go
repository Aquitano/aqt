// Package generic imports arbitrary messages from JSON, the escape hatch for
// agents and one-off sources. Input is a JSON array, a single object, or
// newline-delimited objects:
//
//	{"source": "notes", "body": "...", "sent_at": "2024-05-13T21:08:00Z",
//	 "thread": "...", "sender": "...", "recipients": ["..."], "subject": "...",
//	 "external_id": "...",
//	 "attachments": [{"filename": "report.pdf", "mime_type": "application/pdf", "data": "<base64>"}]}
//
// Only body (or subject) is required; source falls back to --source. Unknown
// fields reject the entry. Attachments carry their bytes as standard base64
// next to a required filename, so a stored input replays on any machine.
//
// sent_at is RFC 3339, "2006-01-02 15:04:05", "2006-01-02" or unix seconds.
// Missing or null means the date is unknown. A time without a zone is read as
// UTC, so the stored instant does not depend on the importing machine.
//
// An omitted external_id is derived from the source, thread, sender, subject,
// body and sent_at as written in the input. Otherwise identical entries get an
// occurrence counter, so a file listing the same note twice keeps both while
// re-imports stay no-ops.
package generic

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"time"
	"unicode"

	"github.com/aquitano/aqt/apps/bank/internal/ingest"
)

type Source struct{}

type Options struct {
	Source string `json:"source,omitempty" help:"Source for entries that do not name one (default json)."`
}

func (o *Options) Normalize() error {
	if o.Source == "" {
		o.Source = "json"
	}
	return ingest.ValidSource(o.Source)
}

func (Source) Kind() string { return "json" }

type entry struct {
	Source      string          `json:"source"`
	ExternalID  string          `json:"external_id"`
	Thread      string          `json:"thread"`
	Sender      string          `json:"sender"`
	Recipients  []string        `json:"recipients"`
	Subject     string          `json:"subject"`
	Body        string          `json:"body"`
	SentAt      json.RawMessage `json:"sent_at"`
	Attachments []attachment    `json:"attachments"`
}

type attachment struct {
	Filename string `json:"filename"`
	MimeType string `json:"mime_type"`
	Data     string `json:"data"`
}

func (Source) Parse(ctx context.Context, raw ingest.Raw, opts Options, out ingest.Emitter) error {
	f, err := raw.Open()
	if err != nil {
		return err
	}
	defer f.Close()
	seen := map[string]int{}
	return eachEntry(f, func(i int, value json.RawMessage) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		m, err := message(value, opts.Source, seen)
		if err != nil {
			out.Issue(ingest.Issuef(ingest.Rejected, "entry %d: %v", i, err))
			return nil
		}
		m.Locator = fmt.Sprintf("entry %d", i)
		return out.Message(m)
	})
}

func message(value json.RawMessage, defaultSource string, seen map[string]int) (ingest.Message, error) {
	dec := json.NewDecoder(bytes.NewReader(value))
	dec.DisallowUnknownFields()
	var e entry
	if err := dec.Decode(&e); err != nil {
		return ingest.Message{}, err
	}
	if e.Source == "" {
		e.Source = defaultSource
	}
	if err := ingest.ValidSource(e.Source); err != nil {
		return ingest.Message{}, err
	}
	if e.Body == "" && e.Subject == "" {
		return ingest.Message{}, fmt.Errorf(`missing "body"`)
	}
	sentAt, timeKey, err := parseSentAt(e.SentAt)
	if err != nil {
		return ingest.Message{}, err
	}
	parts := make([]ingest.Part, 0, len(e.Attachments))
	for j, a := range e.Attachments {
		if a.Filename == "" {
			return ingest.Message{}, fmt.Errorf(`attachment %d: missing "filename"`, j)
		}
		data, err := base64.StdEncoding.DecodeString(a.Data)
		if err != nil {
			return ingest.Message{}, fmt.Errorf("attachment %d: data is not base64: %w", j, err)
		}
		parts = append(parts, ingest.Part{
			Filename: a.Filename,
			MimeType: a.MimeType,
			Open:     func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(data)), nil },
		})
	}
	externalID := e.ExternalID
	if externalID == "" {
		externalID = derivedID(e, timeKey, seen)
	}
	return ingest.Message{
		Source:     e.Source,
		ExternalID: externalID,
		ThreadID:   e.Thread,
		Sender:     e.Sender,
		Recipients: e.Recipients,
		Subject:    e.Subject,
		Body:       e.Body,
		SentAt:     sentAt,
		Parts:      parts,
	}, nil
}

// derivedID hashes only what the input says, never the import time or a
// parsed instant, which depend on when and where the import runs.
func derivedID(e entry, timeKey string, seen map[string]int) string {
	base := e.Source + "\x00" + e.Thread + "\x00" + timeKey + "\x00" + e.Sender + "\x00" + e.Subject + "\x00" + e.Body
	n := seen[base]
	seen[base] = n + 1
	if n > 0 {
		base += fmt.Sprintf("\x00%d", n)
	}
	sum := sha256.Sum256([]byte(base))
	return hex.EncodeToString(sum[:])
}

// eachEntry passes the top-level values of a JSON array, or of a stream of
// objects, to fn one at a time.
func eachEntry(r io.Reader, fn func(int, json.RawMessage) error) error {
	br := bufio.NewReader(r)
	isArray, err := startsWithArray(br)
	if err != nil {
		return err
	}
	dec := json.NewDecoder(br)
	if !isArray {
		for i := 0; ; i++ {
			var value json.RawMessage
			if err := dec.Decode(&value); errors.Is(err, io.EOF) {
				return nil
			} else if err != nil {
				return err
			}
			if err := fn(i, value); err != nil {
				return err
			}
		}
	}
	if _, err := dec.Token(); err != nil {
		return err
	}
	for i := 0; dec.More(); i++ {
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return err
		}
		if err := fn(i, value); err != nil {
			return err
		}
	}
	if _, err := dec.Token(); err != nil {
		return err
	}
	return expectEOF(dec)
}

func startsWithArray(br *bufio.Reader) (bool, error) {
	for {
		c, err := br.ReadByte()
		if errors.Is(err, io.EOF) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if !unicode.IsSpace(rune(c)) {
			return c == '[', br.UnreadByte()
		}
	}
}

// expectEOF rejects anything following the value just decoded. An array with a
// second value or stray bytes after it is a concatenated or truncated file;
// importing its first half and reporting success would hide the rest.
func expectEOF(dec *json.Decoder) error {
	tok, err := dec.Token()
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err != nil {
		return err
	}
	return fmt.Errorf("unexpected %v after the top-level JSON array", tok)
}

// parseSentAt returns the instant and the text the derived id hashes: the
// string as written, or the number as written.
func parseSentAt(raw json.RawMessage) (time.Time, string, error) {
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return time.Time{}, "", nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05", "2006-01-02"} {
			if t, err := time.ParseInLocation(layout, s, time.UTC); err == nil {
				return t, s, nil
			}
		}
		return time.Time{}, "", fmt.Errorf("unparseable sent_at %q", s)
	}
	var n json.Number
	if err := json.Unmarshal(raw, &n); err == nil {
		secs, err := strconv.ParseInt(n.String(), 10, 64)
		if err != nil {
			return time.Time{}, "", fmt.Errorf("unparseable sent_at %s", n)
		}
		return time.Unix(secs, 0).UTC(), n.String(), nil
	}
	return time.Time{}, "", fmt.Errorf("sent_at must be a string or unix seconds")
}

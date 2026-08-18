// Package aichat imports AI conversation history: ChatGPT data exports,
// Claude.ai data exports, and local Claude Code session transcripts. All three
// normalize to the common schema — sender is the role ("user"/"assistant"),
// thread is the conversation title — and message UUIDs from the exports keep
// re-imports idempotent.
package aichat

import (
	"archive/zip"
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aquitano/aqt-bank/internal/archive"
	"github.com/aquitano/aqt-bank/internal/fail"
	"github.com/aquitano/aqt-bank/internal/store"
)

type Result struct {
	Conversations int `json:"conversations"`
	Inserted      int `json:"inserted"`
	Duplicates    int `json:"duplicates"`
	Skipped       int `json:"skipped"`
	// FailedSessions lists transcript files that could not be read or parsed.
	// A directory import continues past them, so the paths belong in the
	// result and not only in a stderr line.
	FailedSessions []string `json:"failed_sessions,omitempty"`
}

type message struct {
	ExternalID string
	Thread     string
	Sender     string
	Body       string
	SentAt     time.Time
}

func (r *Result) ingest(ctx context.Context, st *store.Store, source, rawRef string, msgs []message) error {
	for _, m := range msgs {
		if strings.TrimSpace(m.Body) == "" {
			r.Skipped++
			continue
		}
		if m.ExternalID == "" {
			// One malformed export record (a mapping node without an id, a
			// transcript line without a uuid) must not abort the whole import.
			r.Skipped++
			fmt.Fprintf(os.Stderr, "bank: %s: skipping record without an id in %q\n", source, m.Thread)
			continue
		}
		if m.SentAt.IsZero() {
			m.SentAt = time.Unix(0, 0) // unknown date: obvious epoch sentinel
		}
		id, err := st.InsertMessage(ctx, store.Message{
			Source:     source,
			ExternalID: m.ExternalID,
			ThreadID:   m.Thread,
			Sender:     m.Sender,
			Body:       m.Body,
			SentAt:     m.SentAt,
			RawRef:     rawRef,
		})
		if err != nil {
			return fail.Opf("insert message: %w", err)
		}
		if id == 0 {
			r.Duplicates++
		} else {
			r.Inserted++
		}
	}
	return nil
}

// loadConversations resolves an export given as conversations.json itself, the
// export zip, or an unpacked export directory, archiving the raw input.
func loadConversations(archiveDir, source, path string) ([]byte, string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, "", err
	}
	switch {
	case info.IsDir():
		p := filepath.Join(path, "conversations.json")
		raw, err := os.ReadFile(p)
		if err != nil {
			return nil, "", fmt.Errorf("%s: no conversations.json — not an export directory?", path)
		}
		rawRef, err := archive.Copy(archiveDir, source, p)
		return raw, rawRef, err
	case strings.EqualFold(filepath.Ext(path), ".zip"):
		zr, err := zip.OpenReader(path)
		if err != nil {
			return nil, "", err
		}
		defer zr.Close()
		raw, err := fs.ReadFile(&zr.Reader, "conversations.json")
		if err != nil {
			return nil, "", fmt.Errorf("%s: no conversations.json in zip — not a data export?", path)
		}
		rawRef, err := archive.Copy(archiveDir, source, path)
		return raw, rawRef, err
	default:
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, "", err
		}
		rawRef, err := archive.Copy(archiveDir, source, path)
		return raw, rawRef, err
	}
}

func parseTimestamp(s string) time.Time {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.999999", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Unix(0, 0)
}

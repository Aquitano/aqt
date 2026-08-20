// Package aichat imports AI conversation history: ChatGPT data exports,
// Claude.ai data exports, and local Claude Code session transcripts. All three
// normalize to the common schema — sender is the role ("user"/"assistant"),
// thread is the export's stable conversation id and subject its human title —
// and message UUIDs from the exports keep re-imports idempotent.
//
// Titles are not unique (a ChatGPT export holds dozens of "New chat"), so
// keying threads on them merged unrelated conversations into one.
package aichat

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
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
	// EmptyConversations counts conversations that yielded no importable
	// message and were dropped whole. Without it the loss is invisible: such a
	// conversation never reaches any other counter.
	EmptyConversations int `json:"empty_conversations"`
	// FailedSessions lists transcript files that could not be read or parsed.
	// A directory import continues past them, so the paths belong in the
	// result and not only in a stderr line.
	FailedSessions []string `json:"failed_sessions,omitempty"`
	// SubagentSessions counts Claude Code transcripts that were nothing but
	// subagent sidechain traffic and were deliberately not imported.
	SubagentSessions int `json:"subagent_sessions,omitempty"`
}

type message struct {
	ExternalID string
	Thread     string
	// Subject is the conversation's human title, carried on every message so
	// search ranking and result output can show it. Empty when the export has
	// no title.
	Subject string
	Sender  string
	Body    string
	SentAt  time.Time
}

func (r *Result) ingest(ctx context.Context, st *store.Store, source, rawRef string, msgs []message) error {
	for _, m := range msgs {
		if m.ExternalID == "" {
			// One malformed export record (a mapping node without an id, a
			// transcript line without a uuid) must not abort the whole import.
			r.Skipped++
			named := m.Subject // the title says more to a human than the conversation id
			if named == "" {
				named = m.Thread
			}
			fmt.Fprintf(os.Stderr, "bank: %s: skipping record without an id in %q\n", source, named)
			continue
		}
		if m.SentAt.IsZero() {
			m.SentAt = time.Unix(0, 0) // unknown date: obvious epoch sentinel
		}
		// Rethreading, not a plain insert: an archive filled before threads were
		// keyed on conversation ids still holds these messages under their old
		// title-keyed thread, and only a re-import can move them.
		id, err := st.InsertMessageRethreading(ctx, store.Message{
			Source:     source,
			ExternalID: m.ExternalID,
			ThreadID:   m.Thread,
			Subject:    m.Subject,
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

// shardName matches the numbered files a ChatGPT export splits its
// conversations into (conversations-000.json … conversations-025.json). The
// digits are required: a looser match would also take
// conversation_asset_file_names.json, which is not a conversations array.
var shardName = regexp.MustCompile(`^conversations-(\d+)\.json$`)

// shard is one numbered conversations file, read lazily so a directory and a
// zip can be merged by the same code.
type shard struct {
	num  int
	name string
	read func() ([]byte, error)
}

// shardNumber reports the index of a conversations shard, and whether name is
// one at all.
func shardNumber(name string) (int, bool) {
	m := shardName.FindStringSubmatch(name)
	if m == nil {
		return 0, false
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, false // more digits than an int holds: not a real shard
	}
	return n, true
}

// mergeShards concatenates the shard arrays, in shard order, into the single
// conversations array the importers expect. Ordering is by number, not by
// name, so an export that stops zero-padding still merges in export order.
func mergeShards(shards []shard) ([]byte, error) {
	sort.Slice(shards, func(i, j int) bool { return shards[i].num < shards[j].num })
	if missing := missingShards(shards); len(missing) > 0 {
		names := make([]string, len(missing))
		for i, n := range missing {
			names[i] = strconv.Itoa(n)
		}
		fmt.Fprintf(os.Stderr, "bank: conversation shard(s) %s are missing — importing the %d that are present\n",
			strings.Join(names, ", "), len(shards))
	}
	all := []json.RawMessage{}
	for _, s := range shards {
		raw, err := s.read()
		if err != nil {
			return nil, err
		}
		var convs []json.RawMessage
		if err := json.Unmarshal(raw, &convs); err != nil {
			return nil, fmt.Errorf("%s: %w", s.name, err)
		}
		all = append(all, convs...)
	}
	return json.Marshal(all)
}

// missingShards lists the shard numbers absent from an otherwise contiguous
// run, given shards already sorted by number. Numbering starts wherever the
// first shard does — only holes after it mean a file was lost, which would
// otherwise import as a silently short archive.
func missingShards(shards []shard) []int {
	var missing []int
	for i := 1; i < len(shards); i++ {
		for n := shards[i-1].num + 1; n < shards[i].num; n++ {
			missing = append(missing, n)
		}
	}
	return missing
}

// archiveName names merged shard content the way archive.Copy names a file:
// content hash first, so distinct exports never collide and re-archiving the
// same one is a no-op.
func archiveName(raw []byte) string {
	sum := sha256.Sum256(raw)
	return fmt.Sprintf("%x-conversations.json", sum[:6])
}

// loadConversations resolves an export given as conversations.json itself, the
// export zip, or an unpacked export directory, archiving the raw input. Exports
// since 2026 ship numbered shards instead of one conversations.json; those are
// merged back into one array and archived as that array.
func loadConversations(archiveDir, source, path string) ([]byte, string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, "", err
	}
	switch {
	case info.IsDir():
		p := filepath.Join(path, "conversations.json")
		raw, err := os.ReadFile(p)
		if err == nil {
			rawRef, err := archive.Copy(archiveDir, source, p)
			if err != nil {
				return nil, "", fail.Opf("archive %s: %w", p, err)
			}
			return raw, rawRef, nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return nil, "", err // unreadable is a real failure, not a sharded export
		}
		entries, err := os.ReadDir(path)
		if err != nil {
			return nil, "", err
		}
		var shards []shard
		for _, e := range entries {
			num, ok := shardNumber(e.Name())
			if e.IsDir() || !ok {
				continue
			}
			p := filepath.Join(path, e.Name())
			shards = append(shards, shard{num: num, name: e.Name(), read: func() ([]byte, error) { return os.ReadFile(p) }})
		}
		if len(shards) == 0 {
			return nil, "", fmt.Errorf("%s: no conversations.json or conversations-N.json shards — not an export directory?", path)
		}
		raw, err = mergeShards(shards)
		if err != nil {
			return nil, "", err
		}
		// The merged array is the logical input; the shards it came from have
		// no single path to copy.
		rawRef, err := archive.Write(archiveDir, source, archiveName(raw), raw)
		if err != nil {
			return nil, "", fail.Opf("archive %s: %w", path, err)
		}
		return raw, rawRef, nil
	case strings.EqualFold(filepath.Ext(path), ".zip"):
		zr, err := zip.OpenReader(path)
		if err != nil {
			return nil, "", err
		}
		defer zr.Close()
		raw, err := fs.ReadFile(&zr.Reader, "conversations.json")
		if err != nil {
			// Shards sit at the root next to where conversations.json would be,
			// so entry names are matched whole rather than by base name.
			var shards []shard
			for _, f := range zr.File {
				num, ok := shardNumber(f.Name)
				if f.FileInfo().IsDir() || !ok {
					continue
				}
				shards = append(shards, shard{num: num, name: f.Name, read: func() ([]byte, error) {
					rc, err := f.Open()
					if err != nil {
						return nil, err
					}
					defer rc.Close()
					return io.ReadAll(rc)
				}})
			}
			if len(shards) == 0 {
				return nil, "", fmt.Errorf("%s: no conversations.json or conversations-N.json shards in zip — not a data export?", path)
			}
			if raw, err = mergeShards(shards); err != nil {
				return nil, "", err
			}
		}
		rawRef, err := archive.Copy(archiveDir, source, path)
		if err != nil {
			return nil, "", fail.Opf("archive %s: %w", path, err)
		}
		return raw, rawRef, nil
	default:
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, "", err
		}
		rawRef, err := archive.Copy(archiveDir, source, path)
		if err != nil {
			return nil, "", fail.Opf("archive %s: %w", path, err)
		}
		return raw, rawRef, nil
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

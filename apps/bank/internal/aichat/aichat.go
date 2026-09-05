// Package aichat imports AI conversation history: ChatGPT and Claude.ai data
// exports, and the local session stores of AI coding harnesses (Claude Code,
// Codex, OpenCode, Antigravity — see harness.go for the registry that
// `bank import ai` sweeps). Every source normalizes to the common schema —
// sender is the role ("user"/"assistant"), thread is the source's stable
// conversation id and subject its human title — and stable per-message ids
// keep re-imports idempotent.
//
// Titles are not unique (a ChatGPT export holds dozens of "New chat"), so
// keying threads on them merged unrelated conversations into one.
package aichat

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/store"
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
	Attachments        int `json:"attachments,omitempty"`
	// MissingMedia counts asset references whose file the export does not
	// contain — ChatGPT drops expired assets from the download, so a nonzero
	// count is normal for an old account, not an import failure.
	MissingMedia int `json:"missing_media,omitempty"`
	// FailedSessions lists transcript files that could not be read or parsed.
	// A directory import continues past them, so the paths belong in the
	// result and not only in a stderr line.
	FailedSessions []string `json:"failed_sessions,omitempty"`
	// SubagentSessions counts transcripts that were nothing but subagent
	// sidechain traffic and were deliberately not imported.
	SubagentSessions int `json:"subagent_sessions,omitempty"`
	// UnchangedSessions counts session files a Sync* import skipped because
	// their exact bytes were already archived — and, since archiving happens
	// after ingest, already imported — by an earlier run.
	UnchangedSessions int `json:"unchanged_sessions,omitempty"`
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
	// Attachments are asset references parsed out of the message; resolving
	// them to bytes needs a media source, which only some inputs carry.
	Attachments []assetRef
}

// assetRef names one exported asset: the id keys the file on disk, name and
// mime come from the export's metadata when it has them.
type assetRef struct {
	ID   string
	Name string
	Mime string
}

// media resolves asset ids to their exported bytes. nil media (bare
// conversations.json, claude, claude-code) imports messages text-only, same
// as before attachments existed.
type media struct {
	blobs *blob.Store
	open  func(id string) io.ReadCloser
	// names maps "<id>.dat" to the file's original upload name.
	names map[string]string
}

func (r *Result) ingest(ctx context.Context, st *store.Store, source, rawRef string, msgs []message, md *media) error {
	valid := make([]message, 0, len(msgs))
	messages := make([]store.Message, 0, len(msgs))
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
		valid = append(valid, m)
		messages = append(messages, store.Message{
			Source:     source,
			ExternalID: m.ExternalID,
			ThreadID:   m.Thread,
			Subject:    m.Subject,
			Sender:     m.Sender,
			Body:       m.Body,
			SentAt:     m.SentAt,
			RawRef:     rawRef,
		})
	}
	// Rethreading, not a plain insert: an archive filled before threads were
	// keyed on conversation ids still holds these messages under their old
	// title-keyed thread, and only a re-import can move them.
	ids, err := st.InsertMessages(ctx, messages, store.InsertMessagesOpts{Rethread: true})
	if err != nil {
		return fail.Opf("insert messages: %w", err)
	}
	for i, m := range valid {
		id := ids[i]
		if id == 0 {
			r.Duplicates++
			// Heal attachments: an earlier import from a media-less input
			// (bare conversations.json) inserted the message but could not
			// store the files.
			if md != nil && len(m.Attachments) > 0 {
				if err := r.healAssets(ctx, st, md, source, m); err != nil {
					return err
				}
			}
			continue
		}
		r.Inserted++
		if md != nil {
			for _, a := range m.Attachments {
				if err := r.storeAsset(ctx, st, md, id, a); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func (r *Result) healAssets(ctx context.Context, st *store.Store, md *media, source string, m message) error {
	id, err := st.FindMessageID(ctx, source, m.ExternalID)
	if err != nil {
		return fail.Opf("look up message: %w", err)
	}
	if id == 0 {
		return nil
	}
	has, err := st.MessageHasAttachments(ctx, id)
	if err != nil {
		return fail.Opf("read attachments of message %d: %w", id, err)
	}
	if has {
		return nil
	}
	for _, a := range m.Attachments {
		if err := r.storeAsset(ctx, st, md, id, a); err != nil {
			return err
		}
	}
	return nil
}

func (r *Result) storeAsset(ctx context.Context, st *store.Store, md *media, messageID int64, a assetRef) error {
	rc := md.open(a.ID)
	if rc == nil {
		r.MissingMedia++
		return nil
	}
	defer rc.Close()

	name := md.names[a.ID+".dat"]
	if name == "" {
		name = a.Name
	}
	if name == "" {
		name = a.ID
	}
	mimeType := a.Mime
	if mimeType == "" {
		mimeType = mime.TypeByExtension(filepath.Ext(name))
	}

	// Many exported assets carry no usable extension ("image.png" aside, ids
	// and bare UUIDs are common), so sniff the bytes when nothing named them.
	head := make([]byte, 512)
	n, err := io.ReadFull(rc, head)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return fail.Opf("read asset %q: %w", a.ID, err)
	}
	head = head[:n]
	if mimeType == "" {
		mimeType = http.DetectContentType(head)
	}

	sumHex, size, err := md.blobs.Put(io.MultiReader(bytes.NewReader(head), rc))
	if err != nil {
		return fail.Opf("store asset %q: %w", a.ID, err)
	}
	err = st.InsertAttachment(ctx, store.Attachment{
		MessageID: messageID,
		Filename:  name,
		MimeType:  mimeType,
		SizeBytes: size,
		SHA256:    sumHex,
	})
	if err != nil {
		return fail.Opf("insert attachment %q: %w", name, err)
	}
	r.Attachments++
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

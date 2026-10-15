// Package aichat imports ChatGPT and Claude.ai conversation exports.
// Source conversation IDs and stable message IDs keep reimports idempotent.
package aichat

import (
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
	"github.com/aquitano/aqt/apps/bank/internal/export"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

type Result struct {
	UnsupportedContent int `json:"unsupported_content,omitempty"`
	Conversations      int `json:"conversations"`
	Inserted           int `json:"inserted"`
	Duplicates         int `json:"duplicates"`
	Skipped            int `json:"skipped"`
	// EmptyConversations counts conversations that yielded no importable
	// message and were dropped whole. Without it the loss is invisible: such a
	// conversation never reaches any other counter.
	EmptyConversations int `json:"empty_conversations"`
	Attachments        int `json:"attachments,omitempty"`
	// MissingMedia counts asset references whose file the export does not
	// contain — ChatGPT drops expired assets from the download, so a nonzero
	// count is normal for an old account, not an import failure.
	MissingMedia int `json:"missing_media,omitempty"`
}

type message struct {
	ParentExternalID string
	BranchID         string
	AlternativeIndex int
	ExternalID       string
	Thread           string
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
// conversations.json, claude) imports messages text-only, same
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
			// Claude message without a uuid) must not abort the whole import.
			r.Skipped++
			named := m.Subject // the title says more to a human than the conversation id
			if named == "" {
				named = m.Thread
			}
			store.ImportIssue(ctx, fmt.Sprintf("Record without an id in %s", named))
			fmt.Fprintf(os.Stderr, "bank: %s: skipping record without an id in %q\n", source, named)
			continue
		}
		if m.SentAt.IsZero() {
			m.SentAt = time.Unix(0, 0) // unknown date: obvious epoch sentinel
		}
		valid = append(valid, m)
		messages = append(messages, store.Message{
			Source:           source,
			ExternalID:       m.ExternalID,
			ParentExternalID: m.ParentExternalID,
			BranchID:         m.BranchID,
			AlternativeIndex: m.AlternativeIndex,
			ThreadID:         m.Thread,
			Subject:          m.Subject,
			Sender:           m.Sender,
			Body:             m.Body,
			SentAt:           m.SentAt,
			RawRef:           rawRef,
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
		if md == nil {
			r.MissingMedia += len(m.Attachments)
			for _, a := range m.Attachments {
				store.ImportIssue(ctx, "Missing asset "+a.ID+" in message "+m.ExternalID)
			}
		}
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
				if err := r.storeAsset(ctx, st, md, id, a, nil); err != nil {
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
	have, err := st.AttachmentKeys(ctx, id)
	if err != nil {
		return fail.Opf("read attachments of message %d: %w", id, err)
	}
	for _, a := range m.Attachments {
		if err := r.storeAsset(ctx, st, md, id, a, have); err != nil {
			return err
		}
	}
	return nil
}

func (r *Result) storeAsset(ctx context.Context, st *store.Store, md *media, messageID int64, a assetRef, have map[string]int) error {
	rc := md.open(a.ID)
	if rc == nil {
		r.MissingMedia++
		store.ImportIssue(ctx, fmt.Sprintf("Missing asset %s (%s) in message %d", a.ID, a.Name, messageID))
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
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
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
	key := store.AttachmentKey(sumHex, name)
	if have[key] > 0 {
		have[key]--
		return nil
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

type shard struct {
	num  int
	name string
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

// mergeShards concatenates the numbered conversation files at the export's
// root, in shard order, into the single conversations array the importers
// expect. Ordering is by number, not by name, so an export that stops
// zero-padding still merges in export order.
func mergeShards(fsys fs.FS, contexts ...context.Context) ([]byte, error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil, err
	}
	var shards []shard
	for _, e := range entries {
		if num, ok := shardNumber(e.Name()); ok && !e.IsDir() {
			shards = append(shards, shard{num: num, name: e.Name()})
		}
	}
	if len(shards) == 0 {
		return nil, errors.New("no conversations.json or conversations-N.json shards — not a data export?")
	}
	sort.Slice(shards, func(i, j int) bool { return shards[i].num < shards[j].num })
	if missing := missingShards(shards); len(missing) > 0 {
		if len(contexts) > 0 {
			store.ImportIssue(contexts[0], fmt.Sprintf("Missing conversation shards: %v", missing))
		}
		names := make([]string, len(missing))
		for i, n := range missing {
			names[i] = strconv.Itoa(n)
		}
		fmt.Fprintf(os.Stderr, "bank: conversation shard(s) %s are missing — importing the %d that are present\n",
			strings.Join(names, ", "), len(shards))
	}
	all := []json.RawMessage{}
	for _, s := range shards {
		raw, err := fs.ReadFile(fsys, s.name)
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
func loadConversations(archiveDir, source, path string, contexts ...context.Context) ([]byte, string, error) {
	exp, err := export.Open(path)
	if err != nil {
		return nil, "", err
	}
	defer exp.Close()
	archived := path
	var raw []byte
	if exp.FS == nil {
		raw, err = os.ReadFile(path)
	} else {
		raw, err = fs.ReadFile(exp.FS, "conversations.json")
		switch {
		case errors.Is(err, fs.ErrNotExist):
			if raw, err = mergeShards(exp.FS, contexts...); err != nil {
				return nil, "", fmt.Errorf("%s: %w", path, err)
			}
			if exp.Dir {
				// The merged array is the logical input; the shards it came
				// from have no single path to copy.
				rawRef, err := archive.Write(archiveDir, source, archiveName(raw), raw)
				if err != nil {
					return nil, "", fail.Opf("archive %s: %w", path, err)
				}
				return raw, rawRef, nil
			}
		case exp.Dir:
			archived = filepath.Join(path, "conversations.json")
		}
	}
	if err != nil {
		return nil, "", err
	}
	rawRef, err := archive.Copy(archiveDir, source, archived)
	if err != nil {
		return nil, "", fail.Opf("archive %s: %w", archived, err)
	}
	return raw, rawRef, nil
}

func parseTimestamp(s string) time.Time {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.999999", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Unix(0, 0)
}

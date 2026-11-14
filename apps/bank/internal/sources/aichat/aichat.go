// Package aichat reads ChatGPT and Claude.ai conversation exports.
// Source conversation IDs and stable message IDs keep reimports idempotent.
package aichat

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"regexp"
	"sort"
	"strconv"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/ingest"
)

type Options struct{}

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
	// Attachments are asset references parsed out of the message; only some
	// inputs carry the bytes behind them.
	Attachments []assetRef
}

// assetRef names one exported asset: the id keys the file in the export, name
// and mime come from the export's metadata when it has them.
type assetRef struct {
	ID   string
	Name string
	Mime string
}

// emitConversation sends one conversation's messages. named identifies the
// conversation in issues; part resolves an asset reference to an attachment.
func emitConversation(out ingest.Emitter, source, locator, named string, msgs []message, part func(assetRef) ingest.Part) error {
	if len(msgs) == 0 {
		out.Issue(ingest.Issuef(ingest.Skipped, "%s has no importable message", named))
		return nil
	}
	for _, m := range msgs {
		if m.ExternalID == "" {
			out.Issue(ingest.Issuef(ingest.Skipped, "record without an id in %s", named))
			continue
		}
		im := ingest.Message{
			Source:           source,
			ExternalID:       m.ExternalID,
			ThreadID:         m.Thread,
			Sender:           m.Sender,
			Subject:          m.Subject,
			Body:             m.Body,
			SentAt:           m.SentAt,
			ParentExternalID: m.ParentExternalID,
			BranchID:         m.BranchID,
			AlternativeIndex: m.AlternativeIndex,
			Locator:          locator,
		}
		for _, a := range m.Attachments {
			im.Parts = append(im.Parts, part(a))
		}
		if err := out.Message(im); err != nil {
			return err
		}
	}
	return nil
}

// eachInArray decodes a JSON array one element at a time, so an export of
// hundreds of megabytes is never held whole.
func eachInArray[T any](r io.Reader, name string, each func(T) error) error {
	dec := json.NewDecoder(r)
	tok, err := dec.Token()
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	if d, ok := tok.(json.Delim); !ok || d != '[' {
		return fmt.Errorf("%s: not a JSON array", name)
	}
	for dec.More() {
		var v T
		if err := dec.Decode(&v); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		if err := each(v); err != nil {
			return err
		}
	}
	if _, err := dec.Token(); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

// shardName matches the numbered files a ChatGPT export splits its
// conversations into (conversations-000.json to conversations-025.json). The
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

// conversationFiles names the files at the export's root that hold its
// conversations: conversations.json, or else the numbered shards in shard
// order. Ordering is by number, not by name, so an export that stops
// zero-padding still reads in export order. missing lists the shard numbers
// absent from the run.
func conversationFiles(fsys fs.FS) (names []string, missing []int, err error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil, nil, err
	}
	var shards []shard
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if e.Name() == "conversations.json" {
			return []string{e.Name()}, nil, nil
		}
		if num, ok := shardNumber(e.Name()); ok {
			shards = append(shards, shard{num: num, name: e.Name()})
		}
	}
	sort.Slice(shards, func(i, j int) bool { return shards[i].num < shards[j].num })
	for _, s := range shards {
		names = append(names, s.name)
	}
	return names, missingShards(shards), nil
}

// missingShards lists the shard numbers absent from an otherwise contiguous
// run, given shards already sorted by number. Numbering starts wherever the
// first shard does: only holes after it mean a file was lost, which would
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

// eachConversation decodes every conversation of an input, from a bare
// conversations.json or from the conversation files of an export zip, and
// reports missing shards as an Incomplete issue. It returns how many files it
// read, so a caller can tell an export without conversations.
func eachConversation[T any](raw ingest.Raw, fsys fs.FS, out ingest.Emitter, each func(file string, c T) error) (int, error) {
	if fsys == nil {
		f, err := raw.Open()
		if err != nil {
			return 0, err
		}
		defer f.Close()
		return 1, eachInArray(f, raw.Name, func(c T) error { return each(raw.Name, c) })
	}
	names, missing, err := conversationFiles(fsys)
	if err != nil {
		return 0, err
	}
	if len(missing) > 0 {
		out.Issue(ingest.Issuef(ingest.Incomplete, "conversation shards %v are missing", missing))
	}
	for _, name := range names {
		err := func() error {
			f, err := fsys.Open(name)
			if err != nil {
				return err
			}
			defer f.Close()
			return eachInArray(f, name, func(c T) error { return each(name, c) })
		}()
		if err != nil {
			return 0, err
		}
	}
	return len(names), nil
}

func parseTimestamp(s string) time.Time {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.999999", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

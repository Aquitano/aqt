// Package youtube imports the YouTube watch history from a Google Takeout
// export. Watch history is not in the YouTube Data API, so Takeout is the only
// route to it, and the export is a plain activity log rather than a
// conversation: one record per video watched.
//
// It normalizes onto the common schema by treating the channel as the
// correspondent — sender is the channel name, thread the channel id — so
// `bank thread <channel id>` is everything ever watched from one channel and
// `--from fireship` filters by publisher. The video title is the subject,
// because unlike a chat conversation every record here has a title of its own,
// and the body is the watch URL.
//
// The export carries no per-record id, so external_id is derived the way
// WhatsApp's is: from the video and the second it was watched. The same video
// watched twice is two events; the same event re-exported by an overlapping
// later Takeout is one.
package youtube

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/export"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
)

// Source reads the watch history out of a Takeout zip (an unpacked Takeout
// arrives packed as one) or the history file itself: watch-history.html, the
// format Takeout writes by default, or watch-history.json, the "Multiple
// formats" option.
type Source struct{}

type Options struct{}

func (Source) Kind() string { return "youtube" }

func (Source) Parse(ctx context.Context, raw ingest.Raw, _ Options, out ingest.Emitter) error {
	data, file, err := readHistory(raw)
	if err != nil {
		return err
	}
	history, err := ParseHistory(data, file)
	if err != nil {
		return fmt.Errorf("%s: %w", file, err)
	}
	if len(history.Events) == 0 {
		// Records that parsed but yielded nothing mean the file is a history
		// export, an all-ads file or a localized HTML export whose timestamps
		// no layout reads, and the diagnosis should say so.
		if history.Ads+history.Skipped > 0 {
			return fmt.Errorf("%s: no importable watches, %d ads, %d records unreadable", raw.Name, history.Ads, history.Skipped)
		}
		return fmt.Errorf("%s: no watch records, not a YouTube history export?", raw.Name)
	}
	if history.Ads > 0 {
		out.Issue(ingest.Issuef(ingest.Dropped, "%s: %d advertisement impressions", file, history.Ads))
	}
	if history.Skipped > 0 {
		out.Issue(ingest.Issuef(ingest.Skipped, "%s: %d records with no title or no readable timestamp", file, history.Skipped))
	}
	for _, e := range history.Events {
		if err := out.Message(ingest.Message{
			Source:     "youtube",
			ExternalID: e.ExternalID,
			ThreadID:   e.thread(),
			Sender:     e.Channel,
			Subject:    e.Title,
			Body:       e.URL,
			SentAt:     e.WatchedAt,
			Locator:    file,
		}); err != nil {
			return err
		}
	}
	return nil
}

// thread groups a channel's videos into one conversation. The id is preferred
// over the name for the same reason Discord keys channels on ids: names repeat
// and get changed, ids do not. A record with no channel at all — a removed
// video, or one watched signed out — belongs to no thread.
func (e HistoryEvent) thread() string {
	if e.ChannelID != "" {
		return e.ChannelID
	}
	return e.Channel
}

// watchDigest derives a stable external_id. Identity is the video plus the
// second it was watched: the same event in two overlapping exports hashes the
// same, while the same video watched again hashes differently.
//
// The timestamp is truncated to the second on purpose. Takeout has changed the
// sub-second precision of `time` between export generations, and two watches
// of one video inside the same second are not a thing a person does — so the
// truncation costs nothing and immunizes the id against that drift. Records
// that do collide get an occurrence counter, as WhatsApp's digest does, so
// none are silently dropped; export order is stable across exports, which
// keeps the counter stable too.
//
// It is the wall clock that is hashed, not the UTC instant, for the same
// reason WhatsApp's digest formats without converting: HTML timestamps carry a
// zone abbreviation that resolves against the importing machine's zone, so the
// instant — and a digest derived from it — would change with the machine,
// re-inserting every row when the input is replayed somewhere else. The
// wall clock is what the export wrote and is the same everywhere; JSON
// timestamps are UTC, so for them the two are one thing.
//
// A video the export no longer names is identified by its title instead, which
// is all that survived of it.
func watchDigest(w watch, seen map[string]int) string {
	key := w.VideoID
	if key == "" {
		key = w.Title
	}
	base := key + "\x00" + w.WatchedAt.Format("2006-01-02T15:04:05")
	n := seen[base]
	seen[base] = n + 1
	if n > 0 {
		base += fmt.Sprintf("\x00%d", n)
	}
	sum := sha256.Sum256([]byte(base))
	return hex.EncodeToString(sum[:])
}

// historyNames are the history files this importer reads, matched by base name
// so the export's own directory layout — localized, nested under Takeout/, or
// unpacked flat — does not have to be predicted. JSON wins when an export
// carries both.
var historyNames = []string{"watch-history.json", "watch-history.html"}

// readHistory returns the history file's bytes and its base name, given the
// export zip or the file itself.
func readHistory(raw ingest.Raw) ([]byte, string, error) {
	exp, err := export.Open(raw)
	if err != nil {
		return nil, "", err
	}
	defer exp.Close()
	if exp.FS != nil {
		return readHistoryFS(exp.FS, raw.Name)
	}
	data, err := os.ReadFile(raw.Path)
	if err != nil {
		return nil, "", err
	}
	return data, filepath.Base(raw.Name), nil
}

func readHistoryFS(fsys fs.FS, name string) ([]byte, string, error) {
	found, err := findHistory(fsys)
	if err != nil {
		return nil, "", err
	}
	if found == "" {
		return nil, "", fmt.Errorf("%s: no %s, not a YouTube Takeout export?", name, strings.Join(historyNames, " or "))
	}
	data, err := fs.ReadFile(fsys, found)
	if err != nil {
		return nil, "", err
	}
	return data, path.Base(found), nil
}

// findHistory walks for the history file by base name, in historyNames order.
// A Takeout holds every product the owner exported, so the history is looked
// up by name rather than at a fixed path: the folder around it is named in the
// account's language and has been renamed between export generations.
func findHistory(fsys fs.FS) (string, error) {
	best := len(historyNames)
	var found string
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		// An unreadable corner of the Takeout — another product's folder with
		// the wrong permissions — must not abort the search for a file that is
		// readable. The walk is lexical, so Drive/ and Mail/ come before
		// "YouTube and YouTube Music"/ and would otherwise kill every import.
		if err != nil {
			return nil
		}
		if d.IsDir() {
			return nil
		}
		for i, name := range historyNames[:best] {
			if strings.EqualFold(path.Base(p), name) {
				best, found = i, p
				break
			}
		}
		if best == 0 {
			return fs.SkipAll // the preferred format; nothing left to look for
		}
		return nil
	})
	return found, err
}

// parse picks the reader for the format the file name announces.
func parse(r io.Reader, name string) (watches []watch, ads, skipped int, err error) {
	if strings.EqualFold(filepath.Ext(name), ".html") {
		return parseHTML(r, time.Local)
	}
	return parseJSON(r)
}

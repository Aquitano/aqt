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
	"archive/zip"
	"bytes"
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

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

type Result struct {
	// Channels counts the distinct channels the input covers, whether or not
	// their videos were already archived — it describes the export, the way
	// Inserted and Duplicates describe what it changed.
	Channels   int `json:"channels"`
	Inserted   int `json:"inserted"`
	Duplicates int `json:"duplicates"`
	// Skipped counts records with no title or no readable timestamp: there is
	// nothing to store and nothing to deduplicate on.
	Skipped int `json:"skipped"`
	// Ads counts advertisement impressions dropped on purpose. Reported rather
	// than silent, so the gap between the file's record count and the archive's
	// is explained.
	Ads int `json:"ads,omitempty"`
}

// Import reads the watch history out of a Takeout zip, an unpacked Takeout
// directory, or the history file itself (watch-history.html, the format
// Takeout writes by default, or watch-history.json, the "Multiple formats"
// option). Re-importing an overlapping export is a no-op.
func Import(ctx context.Context, st *store.Store, archiveDir, inputPath string) (Result, error) {
	return store.RunImport(ctx, st, "youtube", inputPath, func(ctx context.Context) (Result, error) {
		return importUnreported(ctx, st, archiveDir, inputPath)
	})
}

func importUnreported(ctx context.Context, st *store.Store, archiveDir, inputPath string) (Result, error) {
	var res Result

	raw, name, err := readHistory(inputPath)
	if err != nil {
		return res, err
	}
	watches, ads, skipped, err := parse(bytes.NewReader(raw), name)
	if err != nil {
		return res, fmt.Errorf("%s: %w", name, err)
	}
	res.Ads, res.Skipped = ads, skipped
	if len(watches) == 0 {
		// Records that parsed but yielded nothing mean the file is a history
		// export — an all-ads file, or a localized HTML export whose timestamps
		// no layout reads — and the diagnosis should say so, not deny the file.
		if ads+skipped > 0 {
			return res, fmt.Errorf("%s: no importable watches — %d ads, %d records unreadable", inputPath, ads, skipped)
		}
		return res, fmt.Errorf("%s: no watch records — not a YouTube history export?", inputPath)
	}

	rawRef, err := archiveHistory(archiveDir, inputPath, name, raw)
	if err != nil {
		return res, err
	}

	channels := map[string]bool{}
	seen := map[string]int{}
	messages := make([]store.Message, 0, len(watches))
	for _, w := range watches {
		thread := w.thread()
		messages = append(messages, store.Message{
			Source:     "youtube",
			ExternalID: watchDigest(w, seen),
			ThreadID:   thread,
			Sender:     w.Channel,
			Subject:    w.Title,
			Body:       w.URL,
			SentAt:     w.WatchedAt,
			RawRef:     rawRef,
		})
		if thread != "" {
			channels[thread] = true
		}
	}
	// Rethreading, not plain insert: thread, subject and sent_at are all
	// derived (channel-name fallback, prefix stripping, HTML zone resolution),
	// so `bank reimport youtube` must be able to re-key rows when a derivation
	// is fixed — the same reason Discord rethreads.
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
	res.Channels = len(channels)
	return res, nil
}

// thread groups a channel's videos into one conversation. The id is preferred
// over the name for the same reason Discord keys channels on ids: names repeat
// and get changed, ids do not. A record with no channel at all — a removed
// video, or one watched signed out — belongs to no thread.
func (w watch) thread() string {
	if w.ChannelID != "" {
		return w.ChannelID
	}
	return w.Channel
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
// re-inserting every row when `bank reimport youtube` runs somewhere else. The
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
// export zip, an unpacked export directory, or the file itself.
func readHistory(inputPath string) ([]byte, string, error) {
	info, err := os.Stat(inputPath)
	if err != nil {
		return nil, "", err
	}
	switch {
	case info.IsDir():
		return readHistoryFS(os.DirFS(inputPath), inputPath)
	case strings.EqualFold(filepath.Ext(inputPath), ".zip"):
		zr, err := zip.OpenReader(inputPath)
		if err != nil {
			return nil, "", err
		}
		defer zr.Close()
		return readHistoryFS(&zr.Reader, inputPath)
	default:
		raw, err := os.ReadFile(inputPath)
		if err != nil {
			return nil, "", err
		}
		return raw, filepath.Base(inputPath), nil
	}
}

func readHistoryFS(fsys fs.FS, inputPath string) ([]byte, string, error) {
	found, err := findHistory(fsys)
	if err != nil {
		return nil, "", err
	}
	if found == "" {
		return nil, "", fmt.Errorf("%s: no %s — not a YouTube Takeout export?", inputPath, strings.Join(historyNames, " or "))
	}
	raw, err := fs.ReadFile(fsys, found)
	if err != nil {
		return nil, "", err
	}
	return raw, path.Base(found), nil
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

// archiveHistory keeps the history file rather than the input it came in. A
// full Takeout is every Google product at once — the mail in it is a source of
// its own, with its own archive copy — and can run to gigabytes, so copying it
// whole under archive/youtube/ would archive other sources' data twice over.
// The bytes kept are exactly the ones this importer read, under the file's own
// name behind a content hash, which is both how archive.Copy names a file and
// what `bank reimport youtube` replays.
func archiveHistory(archiveDir, inputPath, name string, raw []byte) (string, error) {
	sum := sha256.Sum256(raw)
	rawRef, err := archive.Write(archiveDir, "youtube", fmt.Sprintf("%x-%s", sum[:6], name), raw)
	if err != nil {
		return "", fail.Opf("archive %s: %w", inputPath, err)
	}
	return rawRef, nil
}

// parse picks the reader for the format the file name announces.
func parse(r io.Reader, name string) (watches []watch, ads, skipped int, err error) {
	if strings.EqualFold(filepath.Ext(name), ".html") {
		return parseHTML(r, time.Local)
	}
	return parseJSON(r)
}

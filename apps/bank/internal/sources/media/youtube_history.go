package media

import (
	"bytes"
	"io"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/fieldhash"
)

type HistoryEvent struct {
	ExternalID string
	VideoID    string
	Title      string
	URL        string
	Channel    string
	ChannelID  string
	WatchedAt  time.Time
}

type History struct {
	Events  []HistoryEvent
	Ads     int
	Skipped int
}

func ParseHistory(raw []byte, name string) (History, error) {
	watches, ads, skipped, err := parseWatchHistory(bytes.NewReader(raw), name)
	if err != nil {
		return History{}, err
	}
	result := History{Events: make([]HistoryEvent, 0, len(watches)), Ads: ads, Skipped: skipped}
	seen := map[string]int{}
	for _, w := range watches {
		result.Events = append(result.Events, HistoryEvent{
			ExternalID: watchDigest(w, seen), VideoID: w.VideoID, Title: w.Title,
			URL: w.URL, Channel: w.Channel, ChannelID: w.ChannelID, WatchedAt: w.WatchedAt,
		})
	}
	return result, nil
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
	fields := []string{key, w.WatchedAt.Format("2006-01-02T15:04:05")}
	digest := fieldhash.Hex(fields...)
	n := seen[digest]
	seen[digest] = n + 1
	if n > 0 {
		return fieldhash.Hex(append(fields, strconv.Itoa(n))...)
	}
	return digest
}

// parseWatchHistory picks the reader for the format the file name announces.
func parseWatchHistory(r io.Reader, name string) (watches []watch, ads, skipped int, err error) {
	if strings.EqualFold(filepath.Ext(name), ".html") {
		return parseHTML(r, time.Local)
	}
	return parseJSON(r)
}

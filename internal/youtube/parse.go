package youtube

import (
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// watch is one watch event, normalized out of whichever export format carried
// it. VideoID is empty for a video the export no longer names — removed,
// private, or watched signed out — which is still a record worth keeping even
// though only its title survived.
type watch struct {
	VideoID   string
	Title     string
	URL       string
	Channel   string
	ChannelID string
	WatchedAt time.Time
}

// entry is one record of watch-history.json. Nearly everything is optional in
// practice: ads carry no subtitles, removed videos carry no titleUrl, and
// older records carry no details.
type entry struct {
	Title     string `json:"title"`
	TitleURL  string `json:"titleUrl"`
	Subtitles []struct {
		Name string `json:"name"`
		URL  string `json:"url"`
	} `json:"subtitles"`
	Time    string `json:"time"`
	Details []struct {
		Name string `json:"name"`
	} `json:"details"`
}

// adDetail is how Google marks an advertisement impression. Ads are logged in
// the same history as watched videos but are not something the owner chose to
// watch, so they are dropped instead of archived.
const adDetail = "From Google Ads"

// watchedPrefix is how the export phrases a watch. It is written in the
// account's language, so a non-English export keeps the prefix in the title —
// a slightly noisier subject, never a wrong one.
const watchedPrefix = "Watched "

// parseJSON reads watch-history.json, written when the Takeout is configured
// for JSON ("Multiple formats"): one JSON array of activity records. Records
// are decoded one at a time — the raw bytes are held either way, for the
// archive, but a heavy account's history runs to hundreds of megabytes and
// there is no reason to materialize a decoded []entry beside the []watch it
// reduces to.
//
// Ads are counted apart from records that carried nothing usable, so a
// deliberate drop never looks like a parse failure.
//
// A field written in an unexpected shape costs that field, never the export:
// Takeout's own schema reference disagrees with what the exports write —
// details and subtitles are documented as strings and emitted as lists of
// objects — so a shape this importer did not predict is a live possibility
// across export eras, and one such record must not be able to discard the
// other seventeen thousand.
func parseJSON(r io.Reader) (watches []watch, ads, skipped int, err error) {
	dec := json.NewDecoder(r)
	tok, err := dec.Token()
	if err != nil {
		return nil, 0, 0, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '[' {
		return nil, 0, 0, fmt.Errorf("expected a JSON array of history records, got %v", tok)
	}
	for dec.More() {
		var e entry
		if err := dec.Decode(&e); err != nil {
			// A type error is one odd field, not a broken file: the decoder
			// has consumed the whole record and filled everything it could
			// read, so the array still advances and the record keeps whatever
			// survived. If what it lost was the title or the timestamp, watch()
			// drops it below and counts it as skipped, like any other record
			// with nothing to store. A syntax error is unrecoverable — the
			// decoder cannot know where the next record begins — and still
			// ends the import.
			var typeErr *json.UnmarshalTypeError
			if !errors.As(err, &typeErr) {
				return nil, 0, 0, err
			}
		}
		if e.isAd() {
			ads++
			continue
		}
		w, ok := e.watch()
		if !ok {
			skipped++
			continue
		}
		watches = append(watches, w)
	}
	return watches, ads, skipped, nil
}

func (e entry) isAd() bool {
	for _, d := range e.Details {
		if d.Name == adDetail {
			return true
		}
	}
	return false
}

// watch normalizes one record, reporting false for anything with no title or
// no readable timestamp: without those there is nothing to store and nothing
// to deduplicate on.
func (e entry) watch() (watch, bool) {
	title := strings.TrimSpace(strings.TrimPrefix(e.Title, watchedPrefix))
	at, err := time.Parse(time.RFC3339, strings.TrimSpace(e.Time))
	if title == "" || err != nil {
		return watch{}, false
	}
	w := watch{
		Title:     title,
		URL:       strings.TrimSpace(e.TitleURL),
		VideoID:   videoID(e.TitleURL),
		WatchedAt: at,
	}
	if len(e.Subtitles) > 0 {
		w.Channel = strings.TrimSpace(e.Subtitles[0].Name)
		w.ChannelID = channelID(e.Subtitles[0].URL)
	}
	return w, true
}

// videoID reads the v parameter out of a watch URL. www.youtube.com and
// music.youtube.com spell it the same way; anything else — a community post, a
// channel page the export linked instead — has no id to read.
func videoID(rawURL string) string {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return ""
	}
	return u.Query().Get("v")
}

// channelID reads the id out of a channel URL
// (https://www.youtube.com/channel/UC...). A handle URL (/@name) carries no
// id, so that channel is identified by its name alone.
func channelID(rawURL string) string {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return ""
	}
	id, ok := strings.CutPrefix(u.Path, "/channel/")
	if !ok {
		return ""
	}
	return strings.Trim(id, "/")
}

// watch-history.html — the format a default-configured Takeout writes, JSON
// being the opt-in — is one "outer-cell" div per activity record, each holding
// a "body-1" content cell with the watched link, the channel link, and a
// locale-formatted timestamp, plus "caption" cells for the record's metadata
// (products, ad details). The markup is machine-generated by a single producer
// and uniform, so it is read with targeted patterns rather than a full HTML
// parser.
// htmlRecordStart opens one activity record; everything up to the next one is
// that record.
const htmlRecordStart = `<div class="outer-cell`

var (
	htmlBodyCell    = regexp.MustCompile(`(?is)<div class="content-cell[^"]*mdl-typography--body-1[^"]*"[^>]*>(.*?)</div>`)
	htmlCaptionCell = regexp.MustCompile(`(?is)<div class="content-cell[^"]*mdl-typography--caption[^"]*"[^>]*>(.*?)</div>`)
	htmlAnchor      = regexp.MustCompile(`(?is)<a\s[^>]*href="([^"]*)"[^>]*>(.*?)</a>`)
	htmlBreak       = regexp.MustCompile(`(?i)<br\s*/?>`)
	htmlTag         = regexp.MustCompile(`(?s)<[^>]*>`)
)

// parseHTML reads watch-history.html. Its timestamps are the account's wall
// clock with a zone abbreviation ("CEST") rather than an offset, so they are
// resolved against loc — the machine's own zone in production, the same
// treatment WhatsApp exports get and the reason the binary embeds tzdata. An
// abbreviation loc does not know resolves to UTC, which keeps the wall clock
// and loses only the offset.
func parseHTML(r io.Reader, loc *time.Location) (watches []watch, ads, skipped int, err error) {
	doc, err := io.ReadAll(r)
	if err != nil {
		return nil, 0, 0, err
	}
	records := strings.Split(string(doc), htmlRecordStart)
	if len(records) < 2 {
		return nil, 0, 0, fmt.Errorf("no activity records — not a Takeout history page?")
	}
	for _, rec := range records[1:] { // [0] is the page preamble
		if isHTMLAd(rec) {
			ads++
			continue
		}
		cell := htmlBodyCell.FindStringSubmatch(rec)
		if cell == nil {
			skipped++
			continue
		}
		w, ok := parseHTMLRecord(cell[1], loc)
		if !ok {
			skipped++
			continue
		}
		watches = append(watches, w)
	}
	return watches, ads, skipped, nil
}

// isHTMLAd looks for the ad marker only in the record's caption cells, where
// the page writes its Details — a video legitimately titled "… From Google
// Ads" puts those words in the body cell and must stay a watch.
func isHTMLAd(rec string) bool {
	for _, c := range htmlCaptionCell.FindAllStringSubmatch(rec, -1) {
		if strings.Contains(c[1], adDetail) {
			return true
		}
	}
	return false
}

func parseHTMLRecord(cell string, loc *time.Location) (watch, bool) {
	var w watch
	for _, a := range htmlAnchor.FindAllStringSubmatch(cell, -1) {
		href, text := html.UnescapeString(a[1]), htmlText(a[2])
		switch {
		case isChannelURL(href):
			if w.Channel == "" {
				w.Channel, w.ChannelID = text, channelID(href)
			}
		case w.URL == "":
			w.URL, w.VideoID, w.Title = href, videoID(href), text
		}
	}
	lines := htmlLines(cell)
	if len(lines) == 0 {
		return w, false
	}
	// A removed video has no link, so its title is only the first line of
	// text; the timestamp is always the last.
	if w.Title == "" {
		w.Title = strings.TrimSpace(strings.TrimPrefix(lines[0], watchedPrefix))
	}
	at, err := parseHTMLTime(lines[len(lines)-1], loc)
	if w.Title == "" || err != nil {
		return w, false
	}
	w.WatchedAt = at
	return w, true
}

// htmlTimeLayouts are the formats Takeout writes its activity timestamps in.
// The English export leads with the month; a localized one may not, in which
// case the record is skipped rather than guessed at.
var htmlTimeLayouts = []string{
	"Jan 2, 2006, 3:04:05 PM MST",
	"Jan 2, 2006, 15:04:05 MST",
	time.RFC3339,
}

func parseHTMLTime(s string, loc *time.Location) (time.Time, error) {
	for _, layout := range htmlTimeLayouts {
		if t, err := time.ParseInLocation(layout, s, loc); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("unreadable timestamp %q", s)
}

// htmlLines reduces one content cell to its non-empty text lines, <br> being
// the only line break Takeout uses inside a cell.
func htmlLines(cell string) []string {
	var out []string
	for _, l := range strings.Split(htmlBreak.ReplaceAllString(cell, "\n"), "\n") {
		if l = htmlText(l); l != "" {
			out = append(out, l)
		}
	}
	return out
}

// nbsp are the non-breaking spaces Takeout writes between the words of a
// timestamp; a layout that expects plain spaces would reject every one.
var nbsp = strings.NewReplacer("\u00a0", " ", "\u202f", " ")

func htmlText(s string) string {
	return strings.TrimSpace(nbsp.Replace(html.UnescapeString(htmlTag.ReplaceAllString(s, ""))))
}

// isChannelURL reports whether href points at a channel rather than at the
// video that was watched. Takeout has written channel links as /channel/UC...,
// /user/name, /c/name and /@handle across its generations, and the video link
// is never any of those.
func isChannelURL(href string) bool {
	u, err := url.Parse(strings.TrimSpace(href))
	if err != nil {
		return false
	}
	for _, prefix := range []string{"/channel/", "/user/", "/c/", "/@"} {
		if strings.HasPrefix(u.Path, prefix) {
			return true
		}
	}
	return false
}

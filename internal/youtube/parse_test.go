package youtube

import (
	"strings"
	"testing"
	"time"
)

// One export holding every shape the format produces: an ordinary watch, a
// YouTube Music listen, a video the export no longer names, an ad, and a
// record with no channel.
const historyJSON = `[
 {"header":"YouTube","title":"Watched Rust in 100 Seconds",
  "titleUrl":"https://www.youtube.com/watch?v=5C_HPTJg5ek",
  "subtitles":[{"name":"Fireship","url":"https://www.youtube.com/channel/UCsBjURrPoezykLs9EqgamOA"}],
  "time":"2026-08-14T09:12:33.123Z","products":["YouTube"],
  "activityControls":["YouTube watch history"]},
 {"header":"YouTube Music","title":"Watched Weightless",
  "titleUrl":"https://music.youtube.com/watch?v=UfcAVejslrU",
  "subtitles":[{"name":"Marconi Union","url":"https://www.youtube.com/channel/UCLXA0z0mLxJ1CXcNwHZNW9A"}],
  "time":"2026-08-14T22:01:00Z","products":["YouTube"]},
 {"header":"YouTube","title":"Watched a video that has been removed",
  "time":"2026-08-13T18:00:00Z","products":["YouTube"]},
 {"header":"YouTube","title":"Viewed Ads",
  "titleUrl":"https://www.youtube.com/watch?v=adadadadad",
  "time":"2026-08-14T09:11:00Z","details":[{"name":"From Google Ads"}],
  "products":["YouTube"]},
 {"header":"YouTube","title":"Watched https://www.youtube.com/watch?v=abcdefghijk",
  "titleUrl":"https://www.youtube.com/watch?v=abcdefghijk",
  "time":"2026-08-12T07:30:00Z","products":["YouTube"]}
]`

func TestParseJSON(t *testing.T) {
	watches, ads, skipped, err := parseJSON(strings.NewReader(historyJSON))
	if err != nil {
		t.Fatal(err)
	}
	if ads != 1 {
		t.Errorf("ads = %d, want the one Google Ads impression dropped", ads)
	}
	if skipped != 0 {
		t.Errorf("skipped = %d, want none", skipped)
	}
	if len(watches) != 4 {
		t.Fatalf("got %d watches, want 4: %+v", len(watches), watches)
	}

	first := watches[0]
	if first.Title != "Rust in 100 Seconds" {
		t.Errorf("title = %q, want the Watched prefix stripped", first.Title)
	}
	if first.VideoID != "5C_HPTJg5ek" {
		t.Errorf("video id = %q", first.VideoID)
	}
	if first.Channel != "Fireship" || first.ChannelID != "UCsBjURrPoezykLs9EqgamOA" {
		t.Errorf("channel = %q/%q", first.Channel, first.ChannelID)
	}
	if got := first.WatchedAt.UTC().Format("2006-01-02T15:04:05.000Z"); got != "2026-08-14T09:12:33.123Z" {
		t.Errorf("watched at %s", got)
	}

	// music.youtube.com carries the same v parameter, so a listen is keyed the
	// same way a watch is.
	if watches[1].VideoID != "UfcAVejslrU" {
		t.Errorf("music video id = %q", watches[1].VideoID)
	}

	// A removed video keeps its record: only the title survived it.
	removed := watches[2]
	if removed.VideoID != "" || removed.URL != "" || removed.Channel != "" {
		t.Errorf("removed video = %+v, want no url, id or channel", removed)
	}
	if removed.Title != "a video that has been removed" {
		t.Errorf("removed title = %q", removed.Title)
	}
}

func TestParseJSONSkipsRecordsWithNothingToStore(t *testing.T) {
	watches, _, skipped, err := parseJSON(strings.NewReader(
		`[{"header":"YouTube","title":"","time":"2026-08-14T09:12:33Z"},
		  {"header":"YouTube","title":"Watched something","time":""},
		  {"header":"YouTube","title":"Watched something","time":"not a date"}]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(watches) != 0 || skipped != 3 {
		t.Errorf("watches = %+v, skipped = %d, want all three skipped", watches, skipped)
	}
}

func TestParseJSONRejectsSomethingElse(t *testing.T) {
	if _, _, _, err := parseJSON(strings.NewReader(`{"watch-history": []}`)); err == nil {
		t.Fatal("a JSON object is not a history export and should not parse as one")
	}
}

// Takeout's schema reference documents subtitles and details as strings while
// the exports write lists of objects. A record in the shape this importer did
// not predict must cost the fields it touched, never the rest of the export.
func TestParseJSONSurvivesUnexpectedFieldShapes(t *testing.T) {
	watches, _, _, err := parseJSON(strings.NewReader(
		`[{"header":"YouTube","title":"Watched Rust in 100 Seconds",
		   "titleUrl":"https://www.youtube.com/watch?v=5C_HPTJg5ek",
		   "subtitles":[{"name":"Fireship"}],"time":"2026-08-14T09:12:33Z"},
		  {"header":"YouTube","title":"Watched Vim in 100 Seconds",
		   "titleUrl":"https://www.youtube.com/watch?v=RZ4p-saaQkc",
		   "subtitles":"Fireship","time":"2026-08-14T09:20:00Z"},
		  {"header":"YouTube","title":"Watched Go in 100 Seconds",
		   "titleUrl":"https://www.youtube.com/watch?v=446E-r0rXHI",
		   "subtitles":[{"name":"Fireship"}],"time":"2026-08-14T09:30:00Z"}]`))
	if err != nil {
		t.Fatalf("one string-shaped subtitles field ended the whole import: %v", err)
	}
	if len(watches) != 3 {
		t.Fatalf("watches = %d, want all three kept", len(watches))
	}
	if watches[1].Title != "Vim in 100 Seconds" || watches[1].VideoID != "RZ4p-saaQkc" {
		t.Errorf("the odd record lost more than the field it got wrong: %+v", watches[1])
	}
	if watches[1].Channel != "" {
		t.Errorf("channel = %q, want empty — the unreadable field is the one that goes", watches[1].Channel)
	}
}

// Tolerating a bad shape must not extend to tolerating corruption: past a
// syntax error the decoder cannot know where the next record starts, so
// continuing would silently import an arbitrary prefix of the file.
func TestParseJSONStillRejectsMalformedJSON(t *testing.T) {
	if _, _, _, err := parseJSON(strings.NewReader(
		`[{"header":"YouTube","title":"Watched Rust in 100 Seconds",
		   "time":"2026-08-14T09:12:33Z"},{"header":`)); err == nil {
		t.Fatal("a truncated file should end the import, not import what came before it")
	}
}

// The HTML export a default-configured Takeout writes, one outer-cell per
// record. The narrow no-break space before AM is what Takeout actually writes.
// The last record's title names Google Ads without being one — the marker only
// counts in a Details caption.
const historyHTML = `<html><body><div class="mdl-grid">
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">
 <div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">YouTube<br></p></div>
 <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">
  Watched&nbsp;<a href="https://www.youtube.com/watch?v=5C_HPTJg5ek">Rust in 100 Seconds</a><br>
  <a href="https://www.youtube.com/channel/UCsBjURrPoezykLs9EqgamOA">Fireship</a><br>
  Aug 14, 2026, 9:12:33&#8239;AM CEST</div>
 <div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption">Products:<br>&emsp;YouTube<br></div>
</div></div>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">
 <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">
  Watched a video that has been removed<br>Aug 13, 2026, 6:00:00&#8239;PM CEST</div>
</div></div>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">
 <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">
  Watched&nbsp;<a href="https://www.youtube.com/watch?v=adadadadad">An Advertiser</a><br>
  Aug 14, 2026, 9:11:00&#8239;AM CEST</div>
 <div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption">Details:<br>&emsp;From Google Ads<br></div>
</div></div>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">
 <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">
  Watched&nbsp;<a href="https://www.youtube.com/watch?v=qqqqqqqqqqq">What I Learned From Google Ads</a><br>
  Aug 12, 2026, 8:00:00&#8239;AM CEST</div>
 <div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption">Products:<br>&emsp;YouTube<br></div>
</div></div>
</div></body></html>`

func TestParseHTML(t *testing.T) {
	// The page writes a zone abbreviation, not an offset, so the zone it was
	// written in is what makes the assertion below deterministic.
	berlin, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Skipf("no tzdata for Europe/Berlin: %v", err)
	}
	watches, ads, skipped, err := parseHTML(strings.NewReader(historyHTML), berlin)
	if err != nil {
		t.Fatal(err)
	}
	if ads != 1 || skipped != 0 {
		t.Errorf("ads = %d, skipped = %d, want the ad dropped and nothing else lost", ads, skipped)
	}
	if len(watches) != 3 {
		t.Fatalf("got %d watches, want 3: %+v", len(watches), watches)
	}
	first := watches[0]
	if first.Title != "Rust in 100 Seconds" || first.VideoID != "5C_HPTJg5ek" {
		t.Errorf("first = %+v", first)
	}
	if first.Channel != "Fireship" || first.ChannelID != "UCsBjURrPoezykLs9EqgamOA" {
		t.Errorf("channel = %q/%q", first.Channel, first.ChannelID)
	}
	if got := first.WatchedAt.UTC().Format("2006-01-02T15:04:05Z"); got != "2026-08-14T07:12:33Z" {
		t.Errorf("watched at %s, want 9:12:33 CEST read as +02:00", got)
	}
	if watches[1].Title != "a video that has been removed" || watches[1].URL != "" {
		t.Errorf("removed video = %+v", watches[1])
	}
	if watches[2].Title != "What I Learned From Google Ads" {
		t.Errorf("watches[2] = %+v, want the video whose title merely names Google Ads", watches[2])
	}
}

// The HTML export's zone abbreviation resolves against the importing machine's
// zone, so the digest hashes the wall clock: the same file must yield the same
// ids wherever it is imported, or a reimport elsewhere doubles every row.
func TestWatchDigestDoesNotDependOnTheMachineZone(t *testing.T) {
	berlin, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Skipf("no tzdata for Europe/Berlin: %v", err)
	}
	var digests []string
	for _, loc := range []*time.Location{berlin, time.UTC} {
		watches, _, _, err := parseHTML(strings.NewReader(historyHTML), loc)
		if err != nil {
			t.Fatal(err)
		}
		digests = append(digests, watchDigest(watches[0], map[string]int{}))
	}
	if digests[0] != digests[1] {
		t.Errorf("digest differs with the machine zone: %s vs %s", digests[0], digests[1])
	}
}

func TestParseHTMLRejectsSomethingElse(t *testing.T) {
	if _, _, _, err := parseHTML(strings.NewReader("<html><body>nothing here</body></html>"), time.UTC); err == nil {
		t.Fatal("a page with no activity records should not parse as a history export")
	}
}

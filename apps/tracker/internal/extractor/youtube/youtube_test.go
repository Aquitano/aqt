package youtube

import (
	"bytes"
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
)

// testdata/watch.html is curl output with a desktop Chrome user agent,
// trimmed of every inline script but the player response and of the style
// blocks. The live DOM the extension serialises carries the same
// ytInitialPlayerResponse script and the same schema.org microdata tags.

const watchURL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

func extractRaw(t *testing.T, raw []byte) (extractor.Record, Data) {
	t.Helper()
	u, err := url.Parse(watchURL)
	if err != nil {
		t.Fatal(err)
	}
	rec, err := Extractor{}.Extract(context.Background(), raw, u)
	if err != nil {
		t.Fatal(err)
	}
	data, ok := rec.Data.(Data)
	if !ok {
		t.Fatalf("record data is %T, want youtube.Data", rec.Data)
	}
	return rec, data
}

func fixture(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/watch.html")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestExtractWatchPage(t *testing.T) {
	rec, data := extractRaw(t, fixture(t))

	if data.VideoID != "dQw4w9WgXcQ" {
		t.Errorf("video id = %q", data.VideoID)
	}
	if data.Title != "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)" {
		t.Errorf("title = %q", data.Title)
	}
	if data.Channel != "Rick Astley" || data.ChannelID != "UCuAXFkgsw1L7xaCfnd5JJOw" {
		t.Errorf("channel = %q / %q", data.Channel, data.ChannelID)
	}
	if data.DurationSeconds != 213 {
		t.Errorf("duration = %d", data.DurationSeconds)
	}
	if data.Published != "2009-10-24" {
		t.Errorf("published = %q", data.Published)
	}
	if data.ViewCount < 1_000_000_000 {
		t.Errorf("view count = %d", data.ViewCount)
	}
	if !strings.HasPrefix(data.Description, "The official video for") {
		t.Errorf("description = %q", data.Description)
	}
	if len(data.Keywords) == 0 || data.Keywords[0] != "rick astley" {
		t.Errorf("keywords = %v", data.Keywords)
	}
	if rec.Title != data.Title {
		t.Errorf("record title = %q", rec.Title)
	}
	if rec.CanonicalURL != watchURL {
		t.Errorf("canonical url = %q", rec.CanonicalURL)
	}
	if !strings.Contains(rec.SearchText, "Rick Astley") || !strings.Contains(rec.SearchText, "rickroll") {
		t.Errorf("search text = %q", rec.SearchText)
	}
}

func TestExtractFallsBackToMicrodata(t *testing.T) {
	_, data := extractRaw(t, withoutPlayerResponse(t, fixture(t)))

	if data.VideoID != "dQw4w9WgXcQ" {
		t.Errorf("video id = %q", data.VideoID)
	}
	if data.Title != "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)" {
		t.Errorf("title = %q", data.Title)
	}
	if data.Channel != "Rick Astley" {
		t.Errorf("channel = %q", data.Channel)
	}
	// The microdata duration is the rounded-up PT3M34S, not the exact 213 s.
	if data.DurationSeconds != 214 {
		t.Errorf("duration = %d", data.DurationSeconds)
	}
	if data.Published != "2009-10-24" {
		t.Errorf("published = %q", data.Published)
	}
	if data.ViewCount < 1_000_000_000 {
		t.Errorf("view count = %d", data.ViewCount)
	}
	if len(data.Keywords) == 0 || data.Keywords[0] != "rick astley" {
		t.Errorf("keywords = %v", data.Keywords)
	}
}

func TestExtractStaleWhenThePageStateIsAnotherVideo(t *testing.T) {
	u, _ := url.Parse("https://www.youtube.com/watch?v=b0rdUpcs--w")
	if _, err := (Extractor{}).Extract(context.Background(), fixture(t), u); !errors.Is(err, extractor.ErrStale) {
		t.Fatalf("err = %v, want ErrStale", err)
	}
}

func TestExtractNoMatchOnConsentShell(t *testing.T) {
	shell := []byte(`<!doctype html><html><head><title>YouTube</title></head>
		<body><div id="content">Before you continue to YouTube</div></body></html>`)
	u, _ := url.Parse(watchURL)
	if _, err := (Extractor{}).Extract(context.Background(), shell, u); !errors.Is(err, extractor.ErrNoMatch) {
		t.Fatalf("err = %v, want ErrNoMatch", err)
	}
}

func TestMatchRule(t *testing.T) {
	rule := Extractor{}.Rule().WithDefaults()
	rules := []extractor.Rule{rule}
	cases := map[string]bool{
		"https://www.youtube.com/watch?v=dQw4w9WgXcQ": true,
		"https://youtube.com/watch?v=dQw4w9WgXcQ":     true,
		"https://www.youtube.com/watch":               true,
		"https://m.youtube.com/watch?v=x":             false,
		"https://www.youtube.com/watch/x":             false,
		"https://www.youtube.com/@RickAstleyYT":       false,
		"https://example.com/watch?v=x":               false,
	}
	for raw, want := range cases {
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := extractor.MatchRule(rules, u); ok != want {
			t.Errorf("MatchRule(%s) = %v, want %v", raw, ok, want)
		}
	}
	// Two watch URLs on the same path are distinct page views only because
	// the rule lists "v" as a query key.
	if len(rule.QueryKeys) != 1 || rule.QueryKeys[0] != "v" {
		t.Fatalf("query keys = %v", rule.QueryKeys)
	}
	first, _ := url.Parse("https://youtube.com/watch?v=x")
	second, _ := url.Parse("https://youtube.com/watch?v=y")
	if first.Query().Get("v") == second.Query().Get("v") {
		t.Error("expected the two watch URLs to differ by the v query key")
	}
}

func withoutPlayerResponse(t *testing.T, raw []byte) []byte {
	t.Helper()
	out := raw
	for {
		marker := bytes.Index(out, []byte(playerMarker))
		if marker < 0 {
			return out
		}
		start := bytes.LastIndex(out[:marker], []byte("<script"))
		end := bytes.Index(out[marker:], []byte("</script>"))
		if start < 0 || end < 0 {
			t.Fatal("player response script is not enclosed in a script tag")
		}
		out = append(bytes.Clone(out[:start]), out[marker+end+len("</script>"):]...)
	}
}

func TestExtractCurrentWatchDOMAfterNavigation(t *testing.T) {
	raw := []byte(`<script>var ytInitialPlayerResponse={"videoDetails":{"videoId":"previous","title":"Old title","author":"Old channel"}};</script>
 <meta itemprop="identifier" content="previous"><meta itemprop="name" content="Old title">
 <h1>Unrelated heading</h1><ytd-watch-flexy video-id="dQw4w9WgXcQ"></ytd-watch-flexy>
 <ytd-watch-metadata video-id="dQw4w9WgXcQ"><h1><span>Extension badge</span><yt-formatted-string>Current title</yt-formatted-string></h1>
 <ytd-video-owner-renderer><div id="channel-name"><a>Current channel</a></div></ytd-video-owner-renderer>
 <div id="description-inline-expander"><div id="expanded">Current description</div><span id="snippet-text">Duplicate snippet</span></div>
 </ytd-watch-metadata></ytd-watch-flexy>`)
	_, data := extractRaw(t, raw)
	if data.Title != "Current title" || data.Channel != "Current channel" || data.Description != "Current description" {
		t.Fatalf("current watch data = %+v", data)
	}
	for _, invalid := range []string{
		strings.ReplaceAll(string(raw), `video-id="dQw4w9WgXcQ"`, `video-id="previous"`),
		strings.ReplaceAll(string(raw), "<yt-formatted-string>Current title</yt-formatted-string>", ""),
	} {
		u, _ := url.Parse(watchURL)
		if _, err := (Extractor{}).Extract(context.Background(), []byte(invalid), u); !errors.Is(err, extractor.ErrStale) {
			t.Fatalf("invalid watch DOM error = %v, want stale", err)
		}
	}
}

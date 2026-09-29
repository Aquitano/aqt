// The fixtures under testdata/ are hand-written from X's rendered DOM, not a
// real capture. Replace them with an extension capture of a live status page
// (see README.md) and re-check every expectation below against it.
package x

import (
	"context"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
)

func extract(t *testing.T, fixture, pageURL string) (extractor.Record, error) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", fixture))
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(pageURL)
	if err != nil {
		t.Fatal(err)
	}
	return Extractor{}.Extract(context.Background(), raw, u)
}

func TestPlainStatus(t *testing.T) {
	rec, err := extract(t, "status-photo.html", "https://x.com/dexhorthy/status/1965203819281002523")
	if err != nil {
		t.Fatal(err)
	}
	want := Data{
		PostURL:      "https://x.com/dexhorthy/status/1965203819281002523",
		Images:       []Image{{URL: "https://pbs.twimg.com/media/Gabc123.jpg?name=orig", AltText: "Image"}},
		StatusID:     "1965203819281002523",
		AuthorHandle: "dexhorthy",
		AuthorName:   "Dex 🛠 Horthy",
		Text:         "Shipped the extractor 🚀 today.\nFixtures next.",
		PostedAt:     "2026-09-05T14:23:11Z",
		MediaCount:   1,
		Lang:         "en",
	}
	if got := rec.Data.(Data); !reflect.DeepEqual(got, want) {
		t.Errorf("data\ngot  %+v\nwant %+v", got, want)
	}
	if rec.CanonicalURL != "https://x.com/dexhorthy/status/1965203819281002523" {
		t.Errorf("canonical url = %q", rec.CanonicalURL)
	}
	if rec.Title != "@dexhorthy: Shipped the extractor 🚀 today. Fixtures next." {
		t.Errorf("title = %q", rec.Title)
	}
	if rec.SearchText != "dexhorthy\nDex 🛠 Horthy\nShipped the extractor 🚀 today.\nFixtures next." {
		t.Errorf("search text = %q", rec.SearchText)
	}
}

func TestReplyWithQuote(t *testing.T) {
	rec, err := extract(t, "reply-quote.html", "https://x.com/dexhorthy/status/1965203819281002524")
	if err != nil {
		t.Fatal(err)
	}
	want := Data{
		PostURL:         "https://x.com/dexhorthy/status/1965203819281002524",
		Images:          []Image{},
		StatusID:        "1965203819281002524",
		AuthorHandle:    "dexhorthy",
		AuthorName:      "Dex Horthy",
		Text:            "Nein — das Rendern ist das Problem.",
		PostedAt:        "2026-09-05T14:30:00Z",
		ReplyToStatusID: "1965100000000000001",
		QuotedStatusID:  "1965000000000000009",
		MediaCount:      1,
		Lang:            "de",
	}
	if got := rec.Data.(Data); !reflect.DeepEqual(got, want) {
		t.Errorf("data\ngot  %+v\nwant %+v", got, want)
	}
}

func TestShellPageHasNoMatch(t *testing.T) {
	_, err := extract(t, "shell.html", "https://x.com/dexhorthy/status/1965203819281002523")
	if !errors.Is(err, extractor.ErrNoMatch) {
		t.Fatalf("err = %v, want ErrNoMatch", err)
	}
}

func TestRuleMatches(t *testing.T) {
	rules := []extractor.Rule{Extractor{}.Rule().WithDefaults()}
	cases := []struct {
		url  string
		want bool
	}{
		{"https://x.com/dexhorthy/status/1965203819281002523", true},
		{"https://twitter.com/dexhorthy/status/1965203819281002523", true},
		{"https://mobile.x.com/dexhorthy/status/1965203819281002523/photo/1", true},
		{"https://x.com/dexhorthy", false},
		{"https://x.com/i/lists/1965203819281002523", false},
		{"https://example.com/dexhorthy/status/1965203819281002523", false},
	}
	for _, c := range cases {
		u, err := url.Parse(c.url)
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := extractor.MatchRule(rules, u); ok != c.want {
			t.Errorf("MatchRule(%s) = %v, want %v", c.url, ok, c.want)
		}
	}
}

func TestPhotoOnlyPostUsesPopulatedCopyAndKeepsImageMetadata(t *testing.T) {
	raw := []byte(`<article data-testid="tweet">
 <a href="/someone/status/99"><time datetime="2026-09-22T08:00:00Z"></time></a>
 <div role="link"><a href="/author/status/123"><time></time></a>
 <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/quoted.jpg" alt="Quoted image"></div></div>
 </article>
 <article data-testid="tweet"><a href="/author/status/123"><time></time></a></article>
 <article data-testid="tweet">
 <div data-testid="User-Name"><a href="/author">Author</a><a href="/author">@author</a></div>
 <a href="/author/status/123">September 22</a>
 <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/photo?format=jpg&amp;name=medium" alt="A blue house"></div>
 <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/second.jpg?name=small" alt=""></div>
 <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/second.jpg?name=large" alt=""></div>
 <div data-testid="tweetPhoto"><img src="data:image/png;base64,abc" alt="Placeholder"></div>
 <div role="link"><a href="/quoted/status/456"><time></time></a>
 <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/quoted.jpg" alt="Quoted image"></div></div>
 </article>`)
	u, _ := url.Parse("https://x.com/author/status/123/photo/1")
	rec, err := (Extractor{}).Extract(context.Background(), raw, u)
	if err != nil {
		t.Fatal(err)
	}
	data := rec.Data.(Data)
	want := []Image{
		{URL: "https://pbs.twimg.com/media/photo?format=jpg&name=orig", AltText: "A blue house"},
		{URL: "https://pbs.twimg.com/media/second.jpg?name=orig", AltText: ""},
	}
	if !reflect.DeepEqual(data.Images, want) || data.Text != "" || data.PostURL != "https://x.com/author/status/123" || rec.CanonicalURL != data.PostURL {
		t.Fatalf("photo-only data = %+v", data)
	}
	if rec.Title != "@author: A blue house" || !strings.Contains(rec.SearchText, "A blue house") || strings.Contains(rec.SearchText, "Quoted image") {
		t.Fatalf("title = %q, search text = %q", rec.Title, rec.SearchText)
	}
	rec, err = (Extractor{}).Extract(context.Background(), []byte(strings.ReplaceAll(string(raw), "A blue house", "Image")), u)
	if err != nil {
		t.Fatal(err)
	}
	if rec.Title != "@author: Photo post" {
		t.Fatalf("title without descriptive alt text = %q", rec.Title)
	}
}

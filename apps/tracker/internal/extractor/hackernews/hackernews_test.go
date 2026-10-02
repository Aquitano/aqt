package hackernews

import (
	"context"
	"errors"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
)

// The fixtures are logged-out pages rendered by headless Chromium 151 on
// 2026-10-02 and dumped without the doctype, as the extension's outerHTML
// would be, with the one script removed: item?id=33734259 (ask-hn.html),
// item?id=41444855 (show-hn.html) and the comment item?id=41468730
// (comment.html).

func extract(t *testing.T, fixture, pageURL string) (extractor.Record, error) {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + fixture)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(pageURL)
	if err != nil {
		t.Fatal(err)
	}
	return Extractor{}.Extract(context.Background(), raw, u)
}

func extractData(t *testing.T, fixture, pageURL string) (extractor.Record, Data) {
	t.Helper()
	rec, err := extract(t, fixture, pageURL)
	if err != nil {
		t.Fatal(err)
	}
	data, ok := rec.Data.(Data)
	if !ok {
		t.Fatalf("record data is %T, want hackernews.Data", rec.Data)
	}
	return rec, data
}

func TestExtractAskHN(t *testing.T) {
	rec, data := extractData(t, "ask-hn.html", "https://news.ycombinator.com/item?id=33734259&utm_source=x")

	want := Data{
		ID:        33734259,
		Title:     "Ask HN: Books about full text search?",
		Author:    "sopromo",
		Points:    232,
		CreatedAt: "2022-11-24T17:58:39Z",
		Body:      "I would love to learn more about FTS at a very low level and I'm looking for books to read more on that topic. Any good suggestions ?",
	}
	got := data
	got.Comments = nil
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got  %+v\nwant %+v", got, want)
	}
	if rec.Title != want.Title {
		t.Errorf("title = %q", rec.Title)
	}
	if rec.CanonicalURL != "https://news.ycombinator.com/item?id=33734259" {
		t.Errorf("canonical url = %q", rec.CanonicalURL)
	}
	if !strings.Contains(rec.SearchText, "looking for books to read more on that topic") {
		t.Errorf("search text misses the body: %q", rec.SearchText[:200])
	}
}

func TestExtractLinkStory(t *testing.T) {
	_, data := extractData(t, "show-hn.html", "https://news.ycombinator.com/item?id=41444855")

	if data.URL != "https://github.com/nuno-faria/tetris-sql" {
		t.Errorf("url = %q", data.URL)
	}
	if data.Title != "Show HN: Using SQL's Turing completeness to build Tetris" || data.Author != "nffaria" || data.Points != 338 {
		t.Errorf("got %+v", data)
	}
	if data.Body != "" {
		t.Errorf("body = %q, want none", data.Body)
	}
}

func TestExtractCommentsWithTheirDepth(t *testing.T) {
	rec, data := extractData(t, "show-hn.html", "https://news.ycombinator.com/item?id=41444855")

	if len(data.Comments) != 19 {
		t.Fatalf("%d comments, want the 19 the page shows", len(data.Comments))
	}
	want := []Comment{ // Body is a prefix
		{41468730, "jihadjihad", "It seems at first to be a toy or silly intellectual exercise", "2024-09-06T18:50:12Z", 0},
		{41468879, "nffaria", "Thanks for the kind words", "2024-09-06T19:11:48Z", 1},
		{41469039, "tanelpoder", "I once wrote a top-like tool in Oracle's sqlplus client", "2024-09-06T19:32:49Z", 2},
		{41469600, "written-beyond", "I will admit that in the past I've used `RAISE NOTICE`", "2024-09-06T20:48:39Z", 1},
		{41468729, "abhgh", "Cool project!", "2024-09-06T18:50:03Z", 0},
	}
	for i, w := range want {
		got := data.Comments[i]
		if got.ID != w.ID || got.Author != w.Author || got.CreatedAt != w.CreatedAt || got.Depth != w.Depth || !strings.HasPrefix(got.Body, w.Body) {
			t.Errorf("comment %d = %+v, want %+v", i, got, w)
		}
	}
	if !strings.Contains(data.Comments[0].Body, "creative solutions.") || !strings.Contains(data.Comments[0].Body, "\nIt's just a lot of fun") {
		t.Errorf("first comment loses a paragraph break: %q", data.Comments[0].Body)
	}
	for _, c := range data.Comments {
		if !strings.Contains(rec.SearchText, c.Body) {
			t.Errorf("search text misses comment %d", c.ID)
		}
	}
}

func TestCommentPageHasNoMatch(t *testing.T) {
	_, err := extract(t, "comment.html", "https://news.ycombinator.com/item?id=41468730")
	if !errors.Is(err, extractor.ErrNoMatch) {
		t.Fatalf("err = %v, want ErrNoMatch", err)
	}
}

func TestExtractStaleWhenThePageIsAnotherItem(t *testing.T) {
	_, err := extract(t, "ask-hn.html", "https://news.ycombinator.com/item?id=41444855")
	if !errors.Is(err, extractor.ErrStale) {
		t.Fatalf("err = %v, want ErrStale", err)
	}
}

func TestMatchRule(t *testing.T) {
	rules := []extractor.Rule{Extractor{}.Rule().WithDefaults()}
	cases := map[string]bool{
		"https://news.ycombinator.com/item?id=33734259": true,
		"https://news.ycombinator.com/":                 false,
		"https://news.ycombinator.com/news?p=2":         false,
		"https://news.ycombinator.com/user?id=pg":       false,
		"https://news.ycombinator.com/threads?id=pg":    false,
		"https://news.ycombinator.com/reply?id=1":       false,
		"https://ycombinator.com/item?id=33734259":      false,
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
}

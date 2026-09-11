package article

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
)

func extract(t *testing.T, fixture, pageURL string) (extractor.Record, Data) {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + fixture)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(pageURL)
	if err != nil {
		t.Fatal(err)
	}
	rec, err := Extractor{}.Extract(context.Background(), raw, u)
	if err != nil {
		t.Fatal(err)
	}
	data, ok := rec.Data.(Data)
	if !ok {
		t.Fatalf("record data is %T, want article.Data", rec.Data)
	}
	return rec, data
}

func TestExtractPost(t *testing.T) {
	rec, data := extract(t, "post.html",
		"https://notes.mercury.example/backpressure-is-a-product-decision?utm_source=rss")

	if data.Title != "Backpressure is a product decision" {
		t.Errorf("title = %q", data.Title)
	}
	if data.Byline != "Ida Ferreira" {
		t.Errorf("byline = %q", data.Byline)
	}
	if data.SiteName != "Mercury Notes" {
		t.Errorf("site name = %q", data.SiteName)
	}
	if data.Published != "2024-11-19" {
		t.Errorf("published = %q", data.Published)
	}
	if data.Language != "en" {
		t.Errorf("language = %q", data.Language)
	}
	if rec.CanonicalURL != "https://notes.mercury.example/backpressure-is-a-product-decision" {
		t.Errorf("canonical url = %q", rec.CanonicalURL)
	}
	if rec.Title != data.Title {
		t.Errorf("record title = %q, data title = %q", rec.Title, data.Title)
	}

	for _, boilerplate := range []string{
		"Accept all cookies", "Subscribe to the newsletter", "Related reading",
		"Privacy policy", "All rights reserved",
	} {
		if strings.Contains(data.Text, boilerplate) {
			t.Errorf("text keeps boilerplate %q", boilerplate)
		}
	}
	for _, paragraph := range []string{
		"Every queue I have ever added to a system",
		"The interesting question is never whether to apply backpressure.",
		"So write the limit down.",
	} {
		if !strings.Contains(data.Text, paragraph) {
			t.Errorf("text misses %q", paragraph)
		}
	}
	if data.WordCount < 300 || data.WordCount > 420 {
		t.Errorf("word count = %d, want the five paragraphs", data.WordCount)
	}
	if !strings.HasPrefix(rec.SearchText, "Backpressure is a product decision\nIda Ferreira\nMercury Notes\n") {
		t.Errorf("search text = %q", firstLines(rec.SearchText, 4))
	}
}

func TestExtractShellNoMatch(t *testing.T) {
	raw, err := os.ReadFile("testdata/shell.html")
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse("https://app.meridian.example/dashboard")
	if _, err := (Extractor{}).Extract(context.Background(), raw, u); !errors.Is(err, extractor.ErrNoMatch) {
		t.Fatalf("err = %v, want ErrNoMatch", err)
	}
}

func TestRuleIsTheFallback(t *testing.T) {
	github := extractor.Rule{
		Extractor: "github",
		Version:   1,
		Hosts:     []string{"github.com"},
		PathRegex: `^/[^/]+/[^/]+/?$`,
	}
	article := Extractor{}.Rule().WithDefaults()
	cases := map[string]string{
		"https://notes.mercury.example/post":         Name,
		"https://github.com/uptrace/bun":             "github",
		"https://sub.domain.example.co.uk/a/b?c=d#e": Name,
		// github.com belongs to the github rule; its other pages are app
		// shell, not articles.
		"https://github.com/uptrace/bun/issues/1": "",
	}
	for _, rules := range [][]extractor.Rule{{github, article}, {article, github}} {
		for raw, want := range cases {
			u, err := url.Parse(raw)
			if err != nil {
				t.Fatal(err)
			}
			r, ok := extractor.MatchRule(rules, u)
			if got := r.Extractor; got != want || ok != (want != "") {
				t.Errorf("MatchRule(%s) = %q, %v; want %q", raw, got, ok, want)
			}
		}
	}
}

func firstLines(s string, n int) string {
	lines := strings.SplitN(s, "\n", n+1)
	if len(lines) > n {
		lines = lines[:n]
	}
	return strings.Join(lines, "\n")
}

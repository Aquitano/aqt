package github

import (
	"bytes"
	"context"
	"errors"
	"net/url"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
)

// The fixtures are curl output with a desktop Chrome user agent, trimmed of
// unrelated inline scripts and style blocks. The live DOM the extension
// serialises carries the same embeddedData script and the same server
// rendered title, body and state markup.

func extract(t *testing.T, fixture, pageURL string) (extractor.Record, Data) {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + fixture)
	if err != nil {
		t.Fatal(err)
	}
	return extractRaw(t, raw, pageURL)
}

func extractRaw(t *testing.T, raw []byte, pageURL string) (extractor.Record, Data) {
	t.Helper()
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
		t.Fatalf("record data is %T, want github.Data", rec.Data)
	}
	return rec, data
}

func TestExtractIssue(t *testing.T) {
	rec, data := extract(t, "issue-1.html", "https://github.com/uptrace/bun/issues/1")

	want := Data{
		Kind: KindIssue, Owner: "uptrace", Repo: "bun", Number: 1,
		Title:     "Plans for a migration tool similar to go-pg's?",
		State:     "closed",
		Author:    "elliotcourant",
		CreatedAt: "2021-05-03T15:33:09Z",
		Labels:    []string{},
	}
	got := data
	got.Body = ""
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got  %+v\nwant %+v", got, want)
	}
	if !strings.HasPrefix(data.Body, "Do you have any plans to make a migration tool similar to what you did with go-pg?") {
		t.Errorf("body = %q", data.Body)
	}
	if rec.Title != "uptrace/bun#1 Plans for a migration tool similar to go-pg's?" {
		t.Errorf("title = %q", rec.Title)
	}
	if rec.CanonicalURL != "https://github.com/uptrace/bun/issues/1" {
		t.Errorf("canonical url = %q", rec.CanonicalURL)
	}
	if !strings.Contains(rec.SearchText, "SQLite requires a clause to enable foreign keys") {
		t.Errorf("search text misses the body: %q", rec.SearchText)
	}
}

func TestExtractIssueWithoutEmbeddedJSON(t *testing.T) {
	raw, err := os.ReadFile("testdata/issue-1.html")
	if err != nil {
		t.Fatal(err)
	}
	_, data := extractRaw(t, withoutEmbeddedJSON(t, raw), "https://github.com/uptrace/bun/issues/1")

	if data.Title != "Plans for a migration tool similar to go-pg's?" {
		t.Errorf("title = %q", data.Title)
	}
	if data.Author != "elliotcourant" {
		t.Errorf("author = %q", data.Author)
	}
	if data.State != "closed" {
		t.Errorf("state = %q", data.State)
	}
	if !strings.HasPrefix(data.Body, "Do you have any plans to make a migration tool") {
		t.Errorf("body = %q", data.Body)
	}
}

func TestExtractPull(t *testing.T) {
	rec, data := extract(t, "pull-900.html", "https://github.com/uptrace/bun/pull/900")

	want := Data{
		Kind: KindPull, Owner: "uptrace", Repo: "bun", Number: 900,
		Title:     "feat: `dbfixture.New` to accept IDB interface",
		State:     "merged",
		Author:    "hirasawayuki",
		CreatedAt: "2023-09-18T06:13:36Z",
		Labels:    []string{},
	}
	got := data
	got.Body = ""
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got  %+v\nwant %+v", got, want)
	}
	if !strings.HasPrefix(data.Body, "This PR addresses the limitation where the dbfixture.New function") {
		t.Errorf("body = %q", data.Body)
	}
	if rec.Title != "uptrace/bun#900 feat: `dbfixture.New` to accept IDB interface" {
		t.Errorf("title = %q", rec.Title)
	}
	if rec.CanonicalURL != "https://github.com/uptrace/bun/pull/900" {
		t.Errorf("canonical url = %q", rec.CanonicalURL)
	}
}

func TestExtractRepo(t *testing.T) {
	rec, data := extract(t, "repo.html", "https://github.com/uptrace/bun")

	if data.Kind != KindRepo || data.Owner != "uptrace" || data.Repo != "bun" || data.Number != 0 {
		t.Errorf("got %+v", data)
	}
	if !strings.HasPrefix(data.Body, "SQL-first Golang ORM\n\nBun: SQL-first Golang ORM") {
		t.Errorf("body = %q", firstLines(data.Body, 3))
	}
	if !containsAll(data.Labels, "golang", "postgresql", "orm") {
		t.Errorf("labels = %v", data.Labels)
	}
	if rec.Title != "uptrace/bun" {
		t.Errorf("title = %q", rec.Title)
	}
	if rec.CanonicalURL != "https://github.com/uptrace/bun" {
		t.Errorf("canonical url = %q", rec.CanonicalURL)
	}
}

func TestExtractStaleWhenTheEmbeddedDataIsAnotherPage(t *testing.T) {
	for fixture, pageURL := range map[string]string{
		"pull-900.html": "https://github.com/uptrace/bun/pull/901",
		"repo.html":     "https://github.com/uptrace/bun-debug",
	} {
		raw, err := os.ReadFile("testdata/" + fixture)
		if err != nil {
			t.Fatal(err)
		}
		u, _ := url.Parse(pageURL)
		if _, err := (Extractor{}).Extract(context.Background(), raw, u); !errors.Is(err, extractor.ErrStale) {
			t.Errorf("%s at %s: err = %v, want ErrStale", fixture, pageURL, err)
		}
	}
}

func TestExtractNoMatchOnLoginWall(t *testing.T) {
	shell := []byte(`<!doctype html><html><head><title>Sign in to GitHub</title></head>
		<body><div class="auth-form"><h1>Sign in</h1></div></body></html>`)
	u, _ := url.Parse("https://github.com/uptrace/bun/issues/1")
	if _, err := (Extractor{}).Extract(context.Background(), shell, u); !errors.Is(err, extractor.ErrNoMatch) {
		t.Fatalf("err = %v, want ErrNoMatch", err)
	}
}

func TestMatchRule(t *testing.T) {
	rules := []extractor.Rule{Extractor{}.Rule().WithDefaults()}
	cases := map[string]bool{
		"https://github.com/uptrace/bun":                   true,
		"https://github.com/uptrace/bun/":                  true,
		"https://github.com/uptrace/bun/issues/1":          true,
		"https://github.com/uptrace/bun/issues/1#issue-42": true,
		"https://github.com/uptrace/bun/pull/900":          true,
		"https://github.com/uptrace/bun/pull/900/files":    false,
		"https://github.com/settings/tokens":               false,
		"https://github.com/sessions/two-factor":           false,
		"https://github.com/issues/assigned":               false,
		"https://github.com/notifications/subscriptions":   false,
		"https://github.com/uptrace/bun/issues":            false,
		"https://github.com/uptrace/bun/pull/abc":          false,
		"https://github.com/uptrace":                       false,
		"https://github.com/uptrace/bun/blob/master/db.go": false,
		"https://gist.github.com/uptrace/bun":              false,
		"https://example.com/uptrace/bun":                  false,
		"https://github.com/uptrace/bun/issues/1?utm=x":    true,
		"https://github.com/uptrace/bun/discussions/1200":  false,
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

func withoutEmbeddedJSON(t *testing.T, raw []byte) []byte {
	t.Helper()
	const open = `<script type="application/json" data-target="react-app.embeddedData">`
	const closing = `</script>`
	start := bytes.Index(raw, []byte(open))
	if start < 0 {
		t.Fatal("fixture has no embeddedData script")
	}
	end := bytes.Index(raw[start:], []byte(closing))
	if end < 0 {
		t.Fatal("embeddedData script is unterminated")
	}
	return append(bytes.Clone(raw[:start]), raw[start+end+len(closing):]...)
}

func containsAll(values []string, want ...string) bool {
	for _, w := range want {
		if !slices.Contains(values, w) {
			return false
		}
	}
	return true
}

func firstLines(s string, n int) string {
	lines := strings.SplitN(s, "\n", n+1)
	if len(lines) > n {
		lines = lines[:n]
	}
	return strings.Join(lines, "\n")
}

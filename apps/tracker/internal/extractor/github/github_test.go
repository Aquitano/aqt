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

// The fixtures are logged-out pages rendered by headless Chromium and dumped
// without the doctype, as the extension's outerHTML would be, trimmed of style
// blocks and of every script but the react-app embeddedData one, which a
// discussion page does not have.

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
	rec, data := extract(t, "issue-51419.html", "https://github.com/golang/go/issues/51419")

	want := Data{
		Kind: KindIssue, Owner: "golang", Repo: "go", Number: 51419,
		Title:     "fmt: padding flag is not accepted with minus flag",
		State:     "closed",
		Author:    "adamdecaf",
		CreatedAt: "2022-03-01T23:37:36Z",
		Labels:    []string{"Documentation", "FrozenDueToAge", "NeedsFix"},
	}
	got := data
	got.Body, got.Comments = "", nil
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got  %+v\nwant %+v", got, want)
	}
	if !strings.HasPrefix(data.Body, "### What version of Go are you using (`go version`)?") {
		t.Errorf("body = %q", firstLines(data.Body, 3))
	}
	if rec.Title != "golang/go#51419 fmt: padding flag is not accepted with minus flag" {
		t.Errorf("title = %q", rec.Title)
	}
	if rec.CanonicalURL != "https://github.com/golang/go/issues/51419" {
		t.Errorf("canonical url = %q", rec.CanonicalURL)
	}
	if !strings.Contains(rec.SearchText, "the minus and padding character flags don't work") {
		t.Errorf("search text misses the body: %q", firstLines(rec.SearchText, 3))
	}
}

func TestExtractIssueWithoutEmbeddedJSON(t *testing.T) {
	raw, err := os.ReadFile("testdata/issue-51419.html")
	if err != nil {
		t.Fatal(err)
	}
	_, data := extractRaw(t, withoutEmbeddedJSON(t, raw), "https://github.com/golang/go/issues/51419")

	if data.Title != "fmt: padding flag is not accepted with minus flag" {
		t.Errorf("title = %q", data.Title)
	}
	if data.Author != "adamdecaf" {
		t.Errorf("author = %q", data.Author)
	}
	if data.State != "closed" {
		t.Errorf("state = %q", data.State)
	}
	if !strings.HasPrefix(data.Body, "What version of Go are you using (go version)?") {
		t.Errorf("body = %q", firstLines(data.Body, 3))
	}
}

func TestExtractPull(t *testing.T) {
	rec, data := extract(t, "pull-11513.html", "https://github.com/cli/cli/pull/11513")

	want := Data{
		Kind: KindPull, Owner: "cli", Repo: "cli", Number: 11513,
		Title:     "Add `--force` flag to `gh run cancel`",
		State:     "merged",
		Author:    "ankddev",
		CreatedAt: "2025-08-15T07:13:25Z",
		Labels:    []string{},
	}
	got := data
	got.Body, got.Comments = "", nil
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got  %+v\nwant %+v", got, want)
	}
	if !strings.HasPrefix(data.Body, "Fixes #11073.\nDescription\nAdd --force flag to gh run cancel command") {
		t.Errorf("body = %q", firstLines(data.Body, 3))
	}
	if rec.Title != "cli/cli#11513 Add `--force` flag to `gh run cancel`" {
		t.Errorf("title = %q", rec.Title)
	}
	if rec.CanonicalURL != "https://github.com/cli/cli/pull/11513" {
		t.Errorf("canonical url = %q", rec.CanonicalURL)
	}
}

func TestExtractComments(t *testing.T) {
	cases := []struct {
		fixture, pageURL string
		want             []Comment // Body is a prefix
	}{
		{"issue-51419.html", "https://github.com/golang/go/issues/51419", []Comment{
			{Author: "adamdecaf", Body: "Context, we have a 13 character fixed width field", CreatedAt: "2022-03-01T23:49:58Z"},
			{Author: "robpike", Body: "Padding a string with zeros doesn't seem right", CreatedAt: "2022-03-02T01:31:31Z"},
			{Author: "adamdecaf", Body: "I didn't see this existing test", CreatedAt: "2022-03-02T18:37:51Z"},
			{Author: "robpike", Body: "It is very odd to right-pad a string with zeros.", CreatedAt: "2022-03-02T20:59:29Z"},
			{Author: "adamdecaf", Body: "Agreed. There's been a test rejecting this behavior since 2016", CreatedAt: "2022-03-02T22:16:23Z"},
			{Author: "gopherbot", Body: "Change https://go.dev/cl/389434 mentions this issue", CreatedAt: "2022-03-02T23:07:32Z"},
			{Author: "cagedmantis", Body: "/cc @martisch", CreatedAt: "2022-03-05T00:02:12Z"},
			{Author: "gopherbot", Body: "Change https://go.dev/cl/390674 mentions this issue", CreatedAt: "2022-03-08T00:30:45Z"},
		}},
		{"pull-11513.html", "https://github.com/cli/cli/pull/11513", []Comment{
			{Author: "BagToad", Body: "Thank you for this one @ankddev", CreatedAt: "2025-08-18T19:01:35Z"},
			{Author: "ankddev", Body: "@BagToad Done!", CreatedAt: "2025-08-19T05:28:06Z"},
			{Author: "BagToad", Body: "Sorry @ankddev, one more thing", CreatedAt: "2025-08-21T16:50:58Z"},
			{Author: "BagToad", Body: "LGTM - thanks @ankddev!", CreatedAt: "2025-08-21T18:44:48Z"},
		}},
	}
	for _, c := range cases {
		rec, data := extract(t, c.fixture, c.pageURL)
		if len(data.Comments) != len(c.want) {
			t.Errorf("%s: %d comments, want %d: %+v", c.fixture, len(data.Comments), len(c.want), data.Comments)
			continue
		}
		for i, want := range c.want {
			got := data.Comments[i]
			if got.Author != want.Author || got.CreatedAt != want.CreatedAt || !strings.HasPrefix(got.Body, want.Body) {
				t.Errorf("%s comment %d = %+v, want %+v", c.fixture, i, got, want)
			}
			if !strings.Contains(rec.SearchText, got.Body) {
				t.Errorf("%s: search text misses comment %d", c.fixture, i)
			}
		}
	}
}

func TestExtractDiscussion(t *testing.T) {
	rec, data := extract(t, "discussion-3659.html", "https://github.com/cli/cli/discussions/3659")

	want := Data{
		Kind: KindDiscussion, Owner: "cli", Repo: "cli", Number: 3659,
		Title:     "gh auth login with AWS CodeStar Connection",
		State:     "open",
		Author:    "mariaines",
		Labels:    []string{},
		Category:  "Q&A",
		Score:     4,
		CreatedAt: "2021-05-18T20:21:01Z",
	}
	got := data
	got.Body, got.Comments = "", nil
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got  %+v\nwant %+v", got, want)
	}
	if !strings.HasPrefix(data.Body, "I'm trying to use gh in an AWS CodeBuild project") {
		t.Errorf("body = %q", firstLines(data.Body, 3))
	}
	if rec.Title != "cli/cli#3659 gh auth login with AWS CodeStar Connection" {
		t.Errorf("title = %q", rec.Title)
	}
	if rec.CanonicalURL != "https://github.com/cli/cli/discussions/3659" {
		t.Errorf("canonical url = %q", rec.CanonicalURL)
	}
}

func TestExtractDiscussionCommentsAndReplies(t *testing.T) {
	rec, data := extract(t, "discussion-3659.html", "https://github.com/cli/cli/discussions/3659")

	want := []Comment{ // Body is a prefix
		{Author: "vilmibm", Body: "Hi!\nTo clarify, when you ran gh auth login", CreatedAt: "2021-05-18T23:25:24Z", Score: 1, Replies: []Comment{
			{Author: "mariaines", Body: "First I tried without setting the hostname", CreatedAt: "2021-05-18T23:34:52Z"},
		}},
		{Author: "mislav", Body: "I'm not familiar with AWS CodePipeline", CreatedAt: "2021-05-19T10:49:57Z", Score: 2, Answer: true, Replies: []Comment{
			{Author: "vilmibm", Body: "ah, I thought perhaps it was just forwarding requests", CreatedAt: "2021-05-19T15:46:17Z"},
			{Author: "mariaines", Body: "Got it, that makes sense. Thank you!", CreatedAt: "2021-05-19T16:23:36Z"},
			{Author: "ltshb", Body: "@mariaines Did you managed to use gh", CreatedAt: "2025-04-14T07:41:06Z"},
			{Author: "mariaines", Body: "@ltshb I didn't, I just used the regular REST api", CreatedAt: "2025-04-14T16:29:17Z"},
		}},
		{Author: "Alex-Wenner-FHR", Body: "Is there any additional information here?", CreatedAt: "2024-01-10T15:54:11Z", Score: 3},
	}
	var matches func(got, want Comment) bool
	matches = func(got, want Comment) bool {
		if got.Author != want.Author || got.CreatedAt != want.CreatedAt || got.Score != want.Score ||
			got.Answer != want.Answer || !strings.HasPrefix(got.Body, want.Body) || len(got.Replies) != len(want.Replies) {
			return false
		}
		for i := range want.Replies {
			if !matches(got.Replies[i], want.Replies[i]) || !strings.Contains(rec.SearchText, got.Replies[i].Body) {
				return false
			}
		}
		return true
	}
	if len(data.Comments) != len(want) {
		t.Fatalf("%d comments, want %d: %+v", len(data.Comments), len(want), data.Comments)
	}
	for i, w := range want {
		if !matches(data.Comments[i], w) {
			t.Errorf("comment %d = %+v\nwant %+v", i, data.Comments[i], w)
		}
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

func TestExtractStaleWhenThePageStateIsAnotherPage(t *testing.T) {
	for fixture, pageURL := range map[string]string{
		"pull-11513.html":      "https://github.com/cli/cli/pull/11514",
		"repo.html":            "https://github.com/uptrace/bun-debug",
		"discussion-3659.html": "https://github.com/cli/cli/discussions/3660",
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
		"https://github.com/uptrace/bun":                            true,
		"https://github.com/uptrace/bun/":                           true,
		"https://github.com/uptrace/bun/issues/1":                   true,
		"https://github.com/uptrace/bun/issues/1#issue-42":          true,
		"https://github.com/uptrace/bun/pull/900":                   true,
		"https://github.com/uptrace/bun/pull/900/files":             false,
		"https://github.com/settings/tokens":                        false,
		"https://github.com/sessions/two-factor":                    false,
		"https://github.com/issues/assigned":                        false,
		"https://github.com/notifications/subscriptions":            false,
		"https://github.com/uptrace/bun/issues":                     false,
		"https://github.com/uptrace/bun/pull/abc":                   false,
		"https://github.com/uptrace":                                false,
		"https://github.com/uptrace/bun/blob/master/db.go":          false,
		"https://gist.github.com/uptrace/bun":                       false,
		"https://example.com/uptrace/bun":                           false,
		"https://github.com/uptrace/bun/issues/1?utm=x":             true,
		"https://github.com/uptrace/bun/discussions/1200":           true,
		"https://github.com/uptrace/bun/discussions":                false,
		"https://github.com/uptrace/bun/discussions/categories/q-a": false,
		"https://github.com/orgs/community/discussions/1":           false,
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

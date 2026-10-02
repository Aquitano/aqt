// The thread fixtures are Wayback Machine snapshots, not live captures; see
// README.md.
package reddit

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

const (
	wwwThreadURL = "https://www.reddit.com/r/golang/comments/1wplslx/can_you_build_a_kernel_with_go/"
	oldThreadURL = "https://old.reddit.com/r/golang/comments/10b9tto/is_it_just_me_or_does_nobody_really_know_what/"
)

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
		t.Fatalf("record data is %T, want reddit.Data", rec.Data)
	}
	return rec, data
}

func TestExtractThread(t *testing.T) {
	cases := []struct {
		fixture, pageURL, canonical string
		want                        Data // Body is a prefix
	}{
		{"www-thread.html", wwwThreadURL, "https://www.reddit.com/r/golang/comments/1wplslx/", Data{
			ID: "1wplslx", Subreddit: "golang", Title: "Can you build a kernel with Go?",
			Author: "Stickhtot", Score: 47, CreatedAt: "2026-09-25T03:27:36Z",
			Body: `Or anything that usually requires "low level" like C/C++ or Rust`,
		}},
		{"old-thread.html", oldThreadURL, "https://www.reddit.com/r/golang/comments/10b9tto/", Data{
			ID: "10b9tto", Subreddit: "golang", Title: "Is it just me or does nobody really know what idiomatic Go is.",
			Author: "Bayul", Score: 148, CreatedAt: "2023-01-14T00:03:06Z",
			Body: "Hello, fellow Gophers.\nI'm a novice Gopher at best",
		}},
	}
	for _, c := range cases {
		rec, data := extractData(t, c.fixture, c.pageURL)
		got := data
		got.Body, got.Comments = c.want.Body, nil
		if !reflect.DeepEqual(got, c.want) || !strings.HasPrefix(data.Body, c.want.Body) {
			t.Errorf("%s: got %+v\nwant %+v", c.fixture, data, c.want)
		}
		if rec.Title != c.want.Title {
			t.Errorf("%s: title = %q", c.fixture, rec.Title)
		}
		if rec.CanonicalURL != c.canonical {
			t.Errorf("%s: canonical url = %q", c.fixture, rec.CanonicalURL)
		}
	}
}

func TestExtractCommentsWithTheirDepth(t *testing.T) {
	cases := []struct {
		fixture, pageURL string
		count            int
		want             []Comment // Body is a prefix
	}{
		{"www-thread.html", wwwThreadURL, 25, []Comment{
			{"pbwhwd2", "Fluffy_Return1449", "Dont know if a GC language is suitable", 109, "2026-09-25T03:29:22Z", 0},
			{"pbwj39c", "Stickhtot", "I forgot to mention on the post", 4, "2026-09-25T03:36:43Z", 1},
			{"pbwnn4f", "Sibexico", "debug.SetGCPercent(-1)", 3, "2026-09-25T04:05:45Z", 2},
			{"pbwicm2", "tommyTurds", "The GC isn't ideal, but the bigger issue is the scheduler.\nto have", 48, "2026-09-25T03:32:06Z", 1},
			{"pbwv7hi", "weberc2", "You don’t need to use the GC", 20, "2026-09-25T04:56:13Z", 2},
			{"pbwkb6w", "mcvoid1", "With the Go language? Yes.", 21, "2026-09-25T03:44:23Z", 0},
		}},
		// Two comments deleted outright are left out; one whose author
		// deleted their account keeps its text.
		{"old-thread.html", oldThreadURL, 88, []Comment{
			{"j497eie", "[deleted]", "Lorem ipsum dolor sit amet", 25, "2023-01-14T01:07:56Z", 0},
			{"j49kts8", "FirmEstablishment941", "Uber scale problems of this sort", 12, "2023-01-14T02:52:09Z", 1},
			{"j4be1g2", "UniverseCity", "Uber, like almost every other large user", 5, "2023-01-14T14:40:30Z", 2},
			{"j4bh587", "FirmEstablishment941", "Yea even then there’s a lot of issues", 4, "2023-01-14T15:03:33Z", 3},
			{"j49h2jc", "edgmnt_net", "Each microservice team goes off", 3, "2023-01-14T02:22:12Z", 1},
			{"j4afiex", "lankybiker", "Gotta remember this one", 5, "2023-01-14T08:03:02Z", 1},
		}},
	}
	for _, c := range cases {
		rec, data := extractData(t, c.fixture, c.pageURL)
		if len(data.Comments) != c.count {
			t.Errorf("%s: %d comments, want %d", c.fixture, len(data.Comments), c.count)
			continue
		}
		for i, w := range c.want {
			got := data.Comments[i]
			if got.ID != w.ID || got.Author != w.Author || got.Score != w.Score || got.CreatedAt != w.CreatedAt || got.Depth != w.Depth || !strings.HasPrefix(got.Body, w.Body) {
				t.Errorf("%s comment %d = %+v, want %+v", c.fixture, i, got, w)
			}
		}
		for _, got := range data.Comments {
			if got.Body == "" || !strings.Contains(rec.SearchText, got.Body) {
				t.Errorf("%s: comment %s has no body or is missing from the search text", c.fixture, got.ID)
			}
		}
	}
}

func TestExtractCommentPermalinkIsItsOwnRecord(t *testing.T) {
	cases := []struct{ fixture, pageURL, canonical string }{
		{"www-thread.html", "https://www.reddit.com/r/golang/comments/1wplslx/comment/pbwhwd2/", "https://www.reddit.com/r/golang/comments/1wplslx/comment/pbwhwd2/"},
		{"old-thread.html", oldThreadURL + "j497eie/", "https://www.reddit.com/r/golang/comments/10b9tto/comment/j497eie/"},
	}
	for _, c := range cases {
		rec, err := extract(t, c.fixture, c.pageURL)
		if err != nil {
			t.Fatal(err)
		}
		if rec.CanonicalURL != c.canonical {
			t.Errorf("%s: canonical url = %q, want %q", c.pageURL, rec.CanonicalURL, c.canonical)
		}
	}
}

func TestExtractStaleWhenThePageIsAnotherThread(t *testing.T) {
	for fixture, pageURL := range map[string]string{
		"www-thread.html": "https://www.reddit.com/r/golang/comments/1wplsly/",
		"old-thread.html": "https://old.reddit.com/r/golang/comments/10b9ttp/",
	} {
		if _, err := extract(t, fixture, pageURL); !errors.Is(err, extractor.ErrStale) {
			t.Errorf("%s at %s: err = %v, want ErrStale", fixture, pageURL, err)
		}
	}
}

func TestBlockedPageHasNoMatch(t *testing.T) {
	_, err := extract(t, "blocked.html", oldThreadURL)
	if !errors.Is(err, extractor.ErrNoMatch) {
		t.Fatalf("err = %v, want ErrNoMatch", err)
	}
}

func TestMatchRule(t *testing.T) {
	rules := []extractor.Rule{Extractor{}.Rule().WithDefaults()}
	cases := map[string]bool{
		wwwThreadURL: true,
		oldThreadURL: true,
		"https://www.reddit.com/r/golang/comments/1wplslx":                   true,
		"https://www.reddit.com/r/golang/comments/1wplslx/comment/pbwhwd2/":  true,
		"https://www.reddit.com/":                                            false,
		"https://www.reddit.com/r/golang/":                                   false,
		"https://www.reddit.com/r/golang/top/?t=all":                         false,
		"https://www.reddit.com/r/golang/comments/":                          false,
		"https://www.reddit.com/user/spez/":                                  false,
		"https://www.reddit.com/search/?q=go":                                false,
		"https://old.reddit.com/r/golang/new/":                               false,
		"https://example.com/r/golang/comments/1wplslx/can_you_build_kernel": false,
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

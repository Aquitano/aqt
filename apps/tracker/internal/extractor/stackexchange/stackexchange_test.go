package stackexchange

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
)

// The fixtures are logged-out pages rendered by headless Chromium 151 on
// 2026-10-02, after Cloudflare's JavaScript check let it through, dumped
// without the doctype as the extension's outerHTML would be, with script and
// style blocks removed: stackoverflow.com/questions/34031801
// (stackoverflow.html), askubuntu.com/questions/141928 (askubuntu.html), and
// the check itself, as the first response to the Stack Overflow one
// (challenge.html).

const (
	soURL = "https://stackoverflow.com/questions/34031801/function-declaration-syntax-things-in-parenthesis-before-function-name"
	auURL = "https://askubuntu.com/questions/141928/what-is-the-difference-between-bin-sh-and-bin-bash"
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
		t.Fatalf("record data is %T, want stackexchange.Data", rec.Data)
	}
	return rec, data
}

type answerWant struct {
	id        int
	author    string
	score     int
	createdAt string
	accepted  bool
}

func TestExtractQuestionAndAnswers(t *testing.T) {
	cases := []struct {
		fixture, pageURL, canonical string
		question                    Post // Body is a prefix
		title                       string
		tags                        []string
		answers                     []answerWant
	}{
		{
			"stackoverflow.html", soURL, "https://stackoverflow.com/questions/34031801",
			Post{ID: 34031801, Author: "Marcus Vinícius Monteiro", Score: 586, CreatedAt: "2015-12-01T22:56:53Z",
				Body: "I'm sorry I couldn't be more specific in the question title, but I was reading some Go code and I encountered function declarations of this form:\nfunc (h handler) ServeHTTP("},
			"Function declaration syntax: things in parenthesis before function name",
			[]string{"go"},
			[]answerWant{
				{34031889, "evanmcdonnal", 447, "2015-12-01T23:03:31Z", true},
				{34350336, "Abhishek Nalin", 203, "2015-12-18T07:20:40Z", false},
				{66607825, "Michael Freidgeim", 17, "2021-03-12T22:05:50Z", false},
			},
		},
		{
			"askubuntu.html", auURL, "https://askubuntu.com/questions/141928",
			Post{ID: 141928, Author: "Rahul Virpara", Score: 426, CreatedAt: "2012-05-25T03:59:39Z",
				Body: "If I write\n#!/bin/bash\necho \"foo\""},
			"What is the difference between #!/bin/sh and #!/bin/bash?",
			[]string{"bash", "scripts", "sh", "shebang"},
			[]answerWant{
				{141932, "reverendj1", 369, "2012-05-25T04:08:06Z", true},
				{141997, "thomasrutter", 117, "2012-05-25T08:31:19Z", false},
				{573660, "AnkiF", 33, "2015-01-14T11:24:07Z", false},
				{1104171, "山茶树和葡萄树", 15, "2018-12-24T07:27:20Z", false},
			},
		},
	}
	for _, c := range cases {
		rec, data := extractData(t, c.fixture, c.pageURL)
		q := data.Post
		if q.ID != c.question.ID || q.Author != c.question.Author || q.Score != c.question.Score || q.CreatedAt != c.question.CreatedAt || !strings.HasPrefix(q.Body, c.question.Body) {
			t.Errorf("%s: question = %+v, want %+v", c.fixture, q, c.question)
		}
		if data.Title != c.title || rec.Title != c.title || strings.Join(data.Tags, " ") != strings.Join(c.tags, " ") {
			t.Errorf("%s: title %q, record title %q, tags %v", c.fixture, data.Title, rec.Title, data.Tags)
		}
		if rec.CanonicalURL != c.canonical {
			t.Errorf("%s: canonical url = %q", c.fixture, rec.CanonicalURL)
		}
		if len(data.Answers) != len(c.answers) {
			t.Errorf("%s: %d answers, want %d", c.fixture, len(data.Answers), len(c.answers))
			continue
		}
		for i, w := range c.answers {
			a := data.Answers[i]
			got := answerWant{a.ID, a.Author, a.Score, a.CreatedAt, a.Accepted}
			if got != w || a.Body == "" {
				t.Errorf("%s answer %d = %+v with body %q, want %+v", c.fixture, i, got, a.Body, w)
			}
			if !strings.Contains(rec.SearchText, a.Body) {
				t.Errorf("%s: search text misses answer %d", c.fixture, a.ID)
			}
		}
	}
}

func TestExtractComments(t *testing.T) {
	rec, data := extractData(t, "askubuntu.html", auURL)

	if len(data.Comments) != 1 || data.Comments[0] != (Comment{"Franck Dernoncourt", "Same question on SO: Difference between sh and Bash", 0, "2025-10-27T00:36:37Z"}) {
		t.Errorf("question comments = %+v", data.Comments)
	}
	accepted := data.Answers[0].Comments
	if len(accepted) != 5 {
		t.Fatalf("accepted answer has %d comments, want the 5 the page shows: %+v", len(accepted), accepted)
	}
	first := accepted[0]
	if first.Author != "thomasrutter" || first.Score != 47 || first.CreatedAt != "2012-09-05T01:16:16Z" || !strings.HasPrefix(first.Body, "Your first paragraph is quite misleading.") {
		t.Errorf("first comment = %+v", first)
	}
	for _, c := range accepted {
		if c.Author == "" || !strings.Contains(rec.SearchText, c.Body) {
			t.Errorf("comment %+v is incomplete or missing from the search text", c)
		}
	}
}

func TestChallengePageHasNoMatch(t *testing.T) {
	_, err := extract(t, "challenge.html", soURL)
	if !errors.Is(err, extractor.ErrNoMatch) {
		t.Fatalf("err = %v, want ErrNoMatch", err)
	}
}

func TestExtractStaleWhenThePageIsAnotherQuestion(t *testing.T) {
	_, err := extract(t, "askubuntu.html", "https://askubuntu.com/questions/141929")
	if !errors.Is(err, extractor.ErrStale) {
		t.Fatalf("err = %v, want ErrStale", err)
	}
}

func TestMatchRule(t *testing.T) {
	rules := []extractor.Rule{Extractor{}.Rule().WithDefaults()}
	cases := map[string]bool{
		soURL: true,
		auURL: true,
		"https://stackoverflow.com/questions/34031801":                        true,
		"https://stackoverflow.com/questions/34031801/slug/34031889#34031889": true,
		"https://superuser.com/questions/1/x":                                 true,
		"https://serverfault.com/questions/1/x":                               true,
		"https://unix.stackexchange.com/questions/4126/x":                     true,
		"https://stackoverflow.com/":                                          false,
		"https://stackoverflow.com/questions":                                 false,
		"https://stackoverflow.com/questions/tagged/go":                       false,
		"https://stackoverflow.com/questions/ask":                             false,
		"https://stackoverflow.com/users/1/jeff-atwood":                       false,
		"https://stackexchange.com/questions/1":                               false,
		"https://example.com/questions/1":                                     false,
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

package extractor

import (
	"context"
	"net/url"
	"slices"
	"testing"
)

func TestCanonicalJSONSortsKeysAtEveryLevel(t *testing.T) {
	type inner struct {
		Zed  []int  `json:"zed"`
		Beta string `json:"beta"`
	}
	type outer struct {
		Name  string         `json:"name"`
		Inner inner          `json:"inner"`
		Extra map[string]any `json:"extra"`
		Big   int64          `json:"big"`
	}
	v := outer{Name: "x", Inner: inner{Zed: []int{3, 1}, Beta: "b"}, Extra: map[string]any{"k2": 2, "k1": "one"}, Big: 9007199254740993}
	got, err := CanonicalJSON(v)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"big":9007199254740993,"extra":{"k1":"one","k2":2},"inner":{"beta":"b","zed":[3,1]},"name":"x"}`
	if string(got) != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestMatchRule(t *testing.T) {
	rules := []Rule{
		{Extractor: "gh", Hosts: []string{"github.com"}, PathRegex: `^/[^/]+/[^/]+/?$`},
		{Extractor: "yt", Hosts: []string{"*.youtube.com"}, PathRegex: `^/watch$`},
	}
	cases := []struct {
		url  string
		want string
	}{
		{"https://github.com/uptrace/bun", "gh"},
		{"https://github.com/uptrace/bun/issues", ""},
		{"https://GitHub.com/uptrace/bun/", "gh"},
		{"https://www.youtube.com/watch?v=x", "yt"},
		{"https://m.youtube.com/watch", "yt"},
		{"https://youtube.com/watch", ""},
		{"https://example.com/watch", ""},
	}
	for _, c := range cases {
		u, _ := url.Parse(c.url)
		r, ok := MatchRule(rules, u)
		if got := r.Extractor; got != c.want || ok != (c.want != "") {
			t.Errorf("MatchRule(%s) = %q, %v; want %q", c.url, got, ok, c.want)
		}
	}
}

func TestMatchRuleWildcardLosesToASpecificRule(t *testing.T) {
	specific := []Rule{
		{Extractor: "gh", Hosts: []string{"github.com"}, PathRegex: `^/[^/]+/[^/]+/?$`},
		{Extractor: "yt", Hosts: []string{"*.youtube.com"}, PathRegex: `^/watch$`},
	}
	wildcard := Rule{Extractor: "article", Hosts: []string{"*"}}
	cases := []struct {
		url  string
		want string
	}{
		{"https://github.com/uptrace/bun", "gh"},
		{"https://www.youtube.com/watch?v=x", "yt"},
		{"https://example.com/anything", "article"},
		// A host a site rule names never falls through to the wildcard.
		{"https://github.com/uptrace/bun/issues", ""},
		{"https://www.youtube.com/shorts/x", ""},
	}
	orders := [][]Rule{
		append(slices.Clone(specific), wildcard),
		append([]Rule{wildcard}, specific...),
	}
	for _, rules := range orders {
		for _, c := range cases {
			u, _ := url.Parse(c.url)
			r, ok := MatchRule(rules, u)
			if got := r.Extractor; got != c.want || ok != (c.want != "") {
				t.Errorf("MatchRule(%s) with %q first = %q, %v; want %q",
					c.url, rules[0].Extractor, got, ok, c.want)
			}
		}
	}
}

func TestWildcardHostMatchesAnyHost(t *testing.T) {
	r := Rule{Extractor: "article", Hosts: []string{"*"}}
	for _, raw := range []string{"https://example.com/", "https://a.b.c.example.co.uk/x?y=1", "http://localhost:3000/"} {
		u, _ := url.Parse(raw)
		if !r.Matches(u) {
			t.Errorf("Matches(%s) = false", raw)
		}
	}
}

type stub struct{ rule Rule }

func (s stub) Rule() Rule { return s.rule }

func (stub) Extract(context.Context, []byte, *url.URL) (Record, error) { return Record{}, ErrNoMatch }

func TestRulesPublishWildcardsLast(t *testing.T) {
	Register(stub{Rule{Extractor: "zzz-site", Version: 1, Hosts: []string{"zzz.example"}}})
	Register(stub{Rule{Extractor: "aaa-fallback", Version: 1, Hosts: []string{"*"}}})

	var order []string
	for _, r := range Rules() {
		order = append(order, r.Extractor)
	}
	if !slices.Equal(order, []string{"zzz-site", "aaa-fallback"}) {
		t.Errorf("rule order = %v", order)
	}
}

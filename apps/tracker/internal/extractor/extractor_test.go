package extractor

import (
	"net/url"
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

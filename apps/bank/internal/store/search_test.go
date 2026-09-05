package store

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestSearchOptsValidate(t *testing.T) {
	base := SearchOpts{Limit: 20, Fuzzy: 1}
	bad := map[string]SearchOpts{
		"zero limit":     {Limit: 0, Fuzzy: 1},
		"negative limit": {Limit: -1, Fuzzy: 1},
		"limit over cap": {Limit: MaxSearchLimit + 1, Fuzzy: 1},
		"negative fuzzy": {Limit: 20, Fuzzy: -1},
		"fuzzy over cap": {Limit: 20, Fuzzy: MaxFuzzyDistance + 1},
		"until before since": {Limit: 20, Fuzzy: 1,
			Since: time.Date(2024, 5, 2, 0, 0, 0, 0, time.UTC),
			Until: time.Date(2024, 5, 1, 0, 0, 0, 0, time.UTC)},
	}
	for name, o := range bad {
		if err := o.Validate(); err == nil {
			t.Errorf("%s: accepted %+v", name, o)
		}
	}
	for _, o := range []SearchOpts{
		base,
		{Limit: 1, Fuzzy: 0},
		{Limit: MaxSearchLimit, Fuzzy: MaxFuzzyDistance},
	} {
		if err := o.Validate(); err != nil {
			t.Errorf("rejected %+v: %v", o, err)
		}
	}
}

func TestSnippet(t *testing.T) {
	t.Run("engine highlight is unescaped and stripped of markup", func(t *testing.T) {
		got := Snippet("the &lt;b&gt;invoice&lt;/b&gt; &amp; the rest", "unused", "invoice")
		if want := "the <b>invoice</b> & the rest"; got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("long body centres on the match", func(t *testing.T) {
		body := strings.Repeat("padding words here ", 60) + "the hetzner invoice " + strings.Repeat("more words ", 60)
		got := Snippet("", body, "hetzner")
		if !strings.Contains(got, "hetzner invoice") {
			t.Fatalf("snippet lost the match: %q", got)
		}
		if len([]rune(got)) > snippetChars+4 {
			t.Errorf("snippet is %d chars, want at most %d", len([]rune(got)), snippetChars)
		}
		if !strings.HasPrefix(got, "…") {
			t.Errorf("a cut start should be marked: %q", got)
		}
	})

	t.Run("multiple matches anchor on the first", func(t *testing.T) {
		body := "alpha invoice " + strings.Repeat("filler ", 200) + "invoice again"
		got := Snippet("", body, "invoice")
		if !strings.HasPrefix(got, "alpha invoice") {
			t.Errorf("got %q, want the window to start at the first match", got)
		}
	})

	t.Run("no match falls back to the head of the body", func(t *testing.T) {
		body := "nothing relevant in here at all"
		if got := Snippet("", body, "hetzner"); got != body {
			t.Errorf("got %q, want %q", got, body)
		}
	})

	t.Run("empty body yields no snippet", func(t *testing.T) {
		if got := Snippet("", "   ", "anything"); got != "" {
			t.Errorf("got %q, want empty", got)
		}
	})

	t.Run("multi-byte text is cut on rune boundaries", func(t *testing.T) {
		for name, filler := range map[string]string{
			"japanese": "日本語の本文です",
			"emoji":    "🙂🎉🚀",
		} {
			t.Run(name, func(t *testing.T) {
				// No spaces anywhere, so nothing but the cut itself decides
				// where the window starts and ends.
				body := strings.Repeat(filler, 60) + "(hetzner)" + strings.Repeat(filler, 60)
				got := Snippet("", body, "hetzner")
				if !utf8.ValidString(got) {
					t.Errorf("snippet is not valid UTF-8: %q", got)
				}
				if !strings.Contains(got, "hetzner") {
					t.Errorf("snippet lost the match: %q", got)
				}
				if n := len([]rune(got)); n > snippetChars+4 {
					t.Errorf("snippet is %d chars, want at most %d", n, snippetChars)
				}
			})
		}
	})

	t.Run("a term inside a word is not a match", func(t *testing.T) {
		// "voice" occurs only as part of "invoicing", far into the body, so
		// the window stays at the head instead of chasing a false hit.
		body := "opening line " + strings.Repeat("filler ", 200) + "invoicing policy"
		got := Snippet("", body, "voice")
		if !strings.HasPrefix(got, "opening line") {
			t.Errorf("got %q, want the head of the body", got)
		}
	})
}

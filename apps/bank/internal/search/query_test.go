package search

import (
	"reflect"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	for _, tc := range []struct {
		in    string
		mode  Mode
		terms []Term
		want  Mode
		err   string
	}{
		{in: "invoice alice", terms: []Term{{Text: "invoice"}, {Text: "alice"}}, want: Best},
		{in: "  invoice\talice ", mode: Any, terms: []Term{{Text: "invoice"}, {Text: "alice"}}, want: Any},
		{in: "invoice alice", mode: All, terms: []Term{{Text: "invoice"}, {Text: "alice"}}, want: All},
		{in: `invoice -draft -"out of office"`, terms: []Term{{Text: "invoice"}, {Text: "draft", Exclude: true}, {Text: "out of office", Phrase: true, Exclude: true}}, want: Best},
		{in: "-draft", err: "only ones to exclude"},
		{in: `"quarterly  review" deck`, terms: []Term{{Text: "quarterly review", Phrase: true}, {Text: "deck"}}, want: Best},
		{in: `deck "quarterly review`, terms: []Term{{Text: "deck"}, {Text: "quarterly review", Phrase: true}}, want: Best},
		{in: `"cat"`, terms: []Term{{Text: "cat", Phrase: true}}, want: Best},
		{in: `- invoice ""`, terms: []Term{{Text: "invoice"}}, want: Best},
		{in: "für", terms: []Term{{Text: "für"}}, want: Best},
		{in: "   ", err: "must not be empty"},
		{in: "-- ...", err: "no letters or digits"},
		{in: "a", mode: "phrase", err: "match must be best, all or any"},
		{in: strings.Repeat("w ", MaxTerms+1), err: "at most"},
	} {
		q, err := Parse(tc.in, tc.mode)
		if tc.err != "" {
			if err == nil || !strings.Contains(err.Error(), tc.err) {
				t.Errorf("Parse(%q) = %v, want error %q", tc.in, err, tc.err)
			}
			continue
		}
		if err != nil || !reflect.DeepEqual(q.Terms, tc.terms) || q.Mode != tc.want {
			t.Errorf("Parse(%q, %q) = %+v, %v; want %+v in %s", tc.in, tc.mode, q, err, tc.terms, tc.want)
		}
	}
}

func TestDistance(t *testing.T) {
	for word, want := range map[string]int{"cat": 0, "über": 0, "deck!": 1, "contract": 1, "quarterly": 2} {
		if got := Distance(word); got != want {
			t.Errorf("Distance(%q) = %d, want %d", word, got, want)
		}
	}
}

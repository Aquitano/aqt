package search

import (
	"slices"
	"testing"
)

func TestBestMatchListsEveryWordBeforeSome(t *testing.T) {
	hit := func(key string) SearchHit { return SearchHit{Key: key} }
	every := []List{{Name: "messages", Hits: []SearchHit{hit("both")}}}
	some := []List{{Name: "messages", Hits: []SearchHit{hit("one"), hit("both")}}, {Name: "library", Hits: []SearchHit{hit("other")}}}
	var modes []Mode
	run := func(q Query) ([]List, error) {
		modes = append(modes, q.Mode)
		if q.Mode == All {
			return every, nil
		}
		return some, nil
	}
	q := Query{Mode: Best, Terms: []Term{{Text: "a"}, {Text: "b"}}}
	hits, _, err := Rank(q, 0, 3, run)
	var got []string
	for _, h := range hits {
		got = append(got, h.Key)
		if h.Partial != (h.Key != "both") {
			t.Errorf("%s partial = %t", h.Key, h.Partial)
		}
	}
	if err != nil || !slices.Equal(got, []string{"both", "one", "other"}) || !slices.Equal(modes, []Mode{All, Any}) {
		t.Fatalf("hits %v, modes %v, %v", got, modes, err)
	}

	modes = nil
	if hits, _, err = Rank(q, 0, 1, run); err != nil || len(hits) != 1 || hits[0].Partial || len(modes) != 1 {
		t.Fatalf("a page filled by every word ran %v and returned %+v, %v", modes, hits, err)
	}
}

package store_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/store"
)

func TestSharedRefListsCandidates(t *testing.T) {
	st, conn := searchFixture(t)
	if _, err := conn.Exec(t.Context(), `insert into contents(id,blake3,size_bytes) overriding system value values(3,decode(repeat('11',8)||repeat('22',24),'hex'),30)`); err != nil {
		t.Fatal(err)
	}
	_, err := st.Content(t.Context(), "attic:"+strings.Repeat("1", 16))
	ambiguous, ok := errors.AsType[*store.AmbiguousRefError](err)
	if !ok {
		t.Fatalf("shared ref: %v", err)
	}
	want := []store.RefCandidate{
		{Ref: strings.Repeat("1", 17), Size: 10, Volume: "Search", Path: "/docs/Tom & Jerry.pdf"},
		{Ref: strings.Repeat("1", 16) + "2", Size: 30},
	}
	if len(ambiguous.Candidates) != 2 || ambiguous.Candidates[0] != want[0] || ambiguous.Candidates[1] != want[1] {
		t.Fatalf("candidates: %+v", ambiguous.Candidates)
	}
	if _, err := st.Text(t.Context(), 0, strings.Repeat("1", 16)); !errors.As(err, &ambiguous) {
		t.Fatalf("text picked a content for a shared ref: %v", err)
	}
}

func TestLongerRefResolvesSharedPrefix(t *testing.T) {
	st, conn := searchFixture(t)
	if _, err := conn.Exec(t.Context(), `insert into contents(id,blake3,size_bytes) overriding system value values(3,decode(repeat('11',8)||repeat('22',24),'hex'),30)`); err != nil {
		t.Fatal(err)
	}
	for ref, size := range map[string]int64{
		"attic:" + strings.Repeat("1", 16) + "2":  30,
		strings.ToUpper(strings.Repeat("11", 32)): 10,
	} {
		got, err := st.Content(t.Context(), ref)
		if err != nil || got.Size != size || got.Ref != strings.Repeat("1", 16) {
			t.Fatalf("%s: %+v, %v", ref, got, err)
		}
	}
}

func TestParseRefRejectsMalformed(t *testing.T) {
	for _, ref := range []string{"", "attic:" + strings.Repeat("1", 15), strings.Repeat("1", 65), "attic:" + strings.Repeat("1", 15) + "g", "attic: " + strings.Repeat("1", 16)} {
		if _, ok := store.ParseRef(ref); ok {
			t.Errorf("accepted %q", ref)
		}
	}
}

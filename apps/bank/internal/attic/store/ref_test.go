package store_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
)

func TestSharedRefListsCandidates(t *testing.T) {
	st, conn := searchFixture(t)
	if _, err := conn.Exec(t.Context(), `insert into contents(id,blake3,size_bytes) overriding system value values(3,decode(repeat('11',8)||repeat('22',24),'hex'),30);
		insert into entry_versions(entry_id,content_id,size_bytes,first_scan,replaced_scan) values(4,3,30,1,1)`); err != nil {
		t.Fatal(err)
	}
	shared := contentRef(t, "content:"+strings.Repeat("1", 16))
	_, err := st.Content(t.Context(), shared)
	ambiguous, ok := errors.AsType[*store.AmbiguousRefError](err)
	if !ok {
		t.Fatalf("shared ref: %v", err)
	}
	want := []store.RefCandidate{
		{Ref: "content:" + strings.Repeat("1", 17), Size: 10, Volume: "Search", Path: "/docs/Tom & Jerry.pdf"},
		{Ref: "content:" + strings.Repeat("1", 16) + "2", Size: 30, Volume: "Search", Path: "/docs/bundle.zip"},
	}
	if len(ambiguous.Candidates) != 2 || ambiguous.Candidates[0] != want[0] || ambiguous.Candidates[1] != want[1] {
		t.Fatalf("candidates: %+v", ambiguous.Candidates)
	}
	if _, err := st.Text(t.Context(), 0, shared); !errors.As(err, &ambiguous) {
		t.Fatalf("text picked a content for a shared ref: %v", err)
	}
}

func TestLongerRefResolvesSharedPrefix(t *testing.T) {
	st, conn := searchFixture(t)
	if _, err := conn.Exec(t.Context(), `insert into contents(id,blake3,size_bytes) overriding system value values(3,decode(repeat('11',8)||repeat('22',24),'hex'),30)`); err != nil {
		t.Fatal(err)
	}
	for cited, size := range map[string]int64{
		"content:" + strings.Repeat("1", 16) + "2": 30,
		"content:" + strings.Repeat("11", 32):      10,
	} {
		got, err := st.Content(t.Context(), contentRef(t, cited))
		if err != nil || got.Size != size || got.Ref != "content:"+strings.Repeat("1", 16) {
			t.Fatalf("%s: %+v, %v", cited, got, err)
		}
	}
}

func contentRef(t *testing.T, s string) ref.Content {
	t.Helper()
	cited, err := ref.ParseContent(s)
	if err != nil {
		t.Fatal(err)
	}
	return cited
}

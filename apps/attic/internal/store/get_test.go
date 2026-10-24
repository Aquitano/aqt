package store_test

import (
	"strings"
	"testing"
)

func TestRetrievalResolvesFullDigestAndCopies(t *testing.T) {
	st, conn := searchFixture(t)
	if _, err := conn.Exec(t.Context(), `update entries set missing_scan=1 where id=3`); err != nil {
		t.Fatal(err)
	}
	for _, target := range []struct {
		id  int64
		ref string
	}{{3, ""}, {0, strings.Repeat("11", 8)}} {
		got, err := st.Retrieval(t.Context(), target.id, target.ref)
		if err != nil {
			t.Fatal(err)
		}
		if len(got.Places) != 3 || got.Digest[31] != 0x11 || got.Size != 10 {
			t.Fatalf("retrieval: %+v", got)
		}
		if target.id != 0 && (got.Places[0].ID != 3 || !got.Places[0].Missing) {
			t.Fatalf("requested entry: %+v", got.Places)
		}
	}
	if _, err := st.Retrieval(t.Context(), 1, ""); err == nil {
		t.Fatal("accepted directory")
	}
	if _, err := conn.Exec(t.Context(), `update entries set content_id=null,hash_state='pending' where id=4`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Retrieval(t.Context(), 4, ""); err == nil {
		t.Fatal("accepted unhashed file")
	}
	if _, err := conn.Exec(t.Context(), `insert into contents(id,blake3,size_bytes) overriding system value values(3,decode(repeat('11',8)||repeat('22',24),'hex'),10)`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Retrieval(t.Context(), 0, strings.Repeat("11", 8)); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("collision: %v", err)
	}
	if _, err := st.Retrieval(t.Context(), 3, ""); err != nil {
		t.Fatalf("entry should disambiguate: %v", err)
	}
}

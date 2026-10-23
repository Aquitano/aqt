package store_test

import (
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/store"
)

func TestCoverageCountsVolumesAcrossScope(t *testing.T) {
	st, conn := searchFixture(t)
	_, err := conn.Exec(t.Context(), `
 update contents set blake3 = decode(repeat('11',8) || repeat('22',24),'hex') where id = 2;
 update entries set path = '/outside/copy.pdf' where id = 6;
 insert into entries(id,volume_id,parent_id,kind,name,raw_name,path,size_bytes,content_id,hash_state,first_scan,updated_scan)
 overriding system value values
 (7,'00000000-0000-0000-0000-000000000001',1,'file','copy.zip','copy.zip'::bytea,'/docs/copy.zip',20,2,'done',1,1),
 (8,'00000000-0000-0000-0000-000000000001',1,'file','unknown','unknown'::bytea,'/docs/unknown',7,null,'pending',1,1)`)
	if err != nil {
		t.Fatal(err)
	}
	o := store.CoverageOptions{VolumeID: "00000000-0000-0000-0000-000000000001", Under: "/docs", Limit: 1}
	r, err := st.Coverage(t.Context(), o)
	if err != nil {
		t.Fatal(err)
	}
	if r.Contents != 2 || r.Bytes != 30 || r.Undercovered != 1 || r.UndercoveredBytes != 20 || r.UnknownFiles != 1 || r.UnknownBytes != 7 {
		t.Fatalf("totals: %+v", r)
	}
	if len(r.Content) != 1 || r.Content[0].ID != 2 || r.Content[0].Volumes != 1 || r.Content[0].Copies != 2 || len(r.Content[0].Locations) != 2 {
		t.Fatalf("same-volume copies: %+v", r.Content)
	}
	if len(r.Unknown) != 1 || r.Unknown[0].ID != 8 || r.Unknown[0].UpdatedScan != 1 || r.Unknown[0].Updated.IsZero() {
		t.Fatalf("unknown and freshness: %+v", r.Unknown)
	}
	_, err = conn.Exec(t.Context(), `update entries set missing_scan = 1 where id = 6`)
	if err != nil {
		t.Fatal(err)
	}
	o.Offset = 1
	r, err = st.Coverage(t.Context(), o)
	if err != nil {
		t.Fatal(err)
	}
	if r.Undercovered != 2 || r.UndercoveredBytes != 30 || len(r.Content) != 1 || r.Content[0].ID != 1 || r.Content[0].Copies != 2 || len(r.Unknown) != 0 {
		t.Fatalf("missing copy and pagination: %+v", r)
	}
	o.Offset = 10
	r, err = st.Coverage(t.Context(), o)
	if err != nil || r.UndercoveredBytes != 30 || len(r.Content) != 0 || r.UnknownFiles != 1 {
		t.Fatalf("empty page totals: %+v, %v", r, err)
	}
}

func TestCoverageBoundsLocationsPerContent(t *testing.T) {
	st, conn := searchFixture(t)
	_, err := conn.Exec(t.Context(), `
 update entries set missing_scan = 1 where id = 6;
 insert into entries(id,volume_id,parent_id,kind,name,raw_name,path,content_id,hash_state,first_scan,updated_scan)
 overriding system value
 select 100+n, '00000000-0000-0000-0000-000000000001', 1, 'file',
 'copy-' || n, convert_to('copy-' || n, 'UTF8'), '/copies/' || n, 2, 'done', 1, 1
 from generate_series(1,105) n;`)
	if err != nil {
		t.Fatal(err)
	}
	r, err := st.Coverage(t.Context(), store.CoverageOptions{Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Content) != 2 || r.Content[0].ID != 2 || r.Content[1].ID != 1 {
		t.Fatalf("content page: %+v", r.Content)
	}
	if r.Content[0].Copies != 106 || len(r.Content[0].Locations) != r.LocationLimit || len(r.Content[1].Locations) != 2 {
		t.Fatalf("per-content limits: %+v", r)
	}
	for _, c := range r.Content {
		for i, location := range c.Locations {
			if i > 0 && location.Path < c.Locations[i-1].Path {
				t.Fatalf("locations are not ordered: %+v", c.Locations)
			}
		}
	}
}

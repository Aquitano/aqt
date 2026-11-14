package store_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/search"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

// find runs the combined search over st and the file catalogue in dsn.
func find(t *testing.T, st *store.Store, dsn, query string, mode search.Mode, f search.Filters, limit, offset int) catalog.Result {
	t.Helper()
	found, err := catalog.Find(t.Context(), st, storetest.OpenCatalogue(t, dsn), query, mode, f, limit, offset)
	if err != nil {
		t.Fatal(err)
	}
	return found
}

func TestSearchRetrievalCases(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	labels := map[string]string{}
	for _, m := range []store.Message{
		{ExternalID: "invoice", Subject: "Hetzner invoice", Body: "Your monthly hosting bill", Sender: "billing@example.com"},
		{ExternalID: "noise", Subject: "Weekend plans", Body: "invoice"},
		{ExternalID: "typo", Subject: "Hetzner invoixe", Body: "Your monthly hosting bill"},
		{ExternalID: "cross-field", Sender: "Alice", Body: "retainer agreement"},
		{ExternalID: "phrase", Body: "We agreed to a quarterly review of the retainer."},
		{ExternalID: "reversed", Body: "review the quarterly retainer"},
		{ExternalID: "umlaut", Subject: "Überweisung für März"},
		{ExternalID: "cat", Body: "the cat sat on the mat"},
		{ExternalID: "car", Body: "the car is parked"},
		{ExternalID: "launch", Body: "the orbital launch contract was late"},
	} {
		id, err := st.InsertMessage(ctx, msg("notes", m.ExternalID, m))
		if err != nil {
			t.Fatal(err)
		}
		written, _, err := st.GetMessage(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		labels[written.Ref] = m.ExternalID
	}
	for name, text := range map[string]string{"Werkstudentenvertrag_2024.pdf": "", "orbital-contract.pdf": "signed orbital contract"} {
		d := content.Sum([]byte(name))
		if _, err := st.WriteMessages(ctx, withAttachment("mail-"+name, name, d)); err != nil {
			t.Fatal(err)
		}
		if text != "" {
			if err := st.PutBlobText(ctx, store.BlobText{BLAKE3: d, Text: text, Status: "ok"}); err != nil {
				t.Fatal(err)
			}
		}
	}
	labelOf := func(h search.SearchHit) string {
		if h.Kind == search.KindMessage {
			return labels[h.Ref]
		}
		return h.Title
	}

	for _, tc := range []struct {
		name, query string
		mode        search.Mode
		first       string
		absent      []string
	}{
		{"an umlaut is found without it", "uberweisung", search.All, "umlaut", nil},
		{"a filename fragment finds the file", "werkstudent", search.All, "Werkstudentenvertrag_2024.pdf", nil},
		{"a typo in a long word is tolerated", "hetzner invoicce", search.All, "invoice", []string{"typo", "noise"}},
		{"a short word matches exactly", "cat", search.All, "cat", []string{"car"}},
		{"a phrase keeps its order", `"quarterly review"`, search.All, "phrase", []string{"reversed"}},
		{"every word, across fields", "alice retainer", search.All, "cross-field", []string{"phrase", "reversed"}},
		{"any word ranks the fuller match first", "hetzner invoice", search.Any, "invoice", nil},
		{"a file found by name and text outranks a message", "orbital contract", search.All, "orbital-contract.pdf", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			found := find(t, st, dsn, tc.query, tc.mode, search.Filters{}, 20, 0)
			var got []string
			for _, h := range found.Hits {
				got = append(got, labelOf(h))
			}
			if len(got) == 0 || got[0] != tc.first {
				t.Fatalf("hits %q, want %s first", got, tc.first)
			}
			for _, absent := range tc.absent {
				if slices.Contains(got, absent) {
					t.Errorf("hits %q include %s", got, absent)
				}
			}
		})
	}
}

// Bytes attached to a message, kept as a library file and copied to a disk
// are one hit that lists all three places.
func TestAContentInThreePlacesIsOneHit(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	d := content.Sum([]byte("lease"))
	if _, err := st.WriteMessages(ctx, withAttachment("m1", "lease.pdf", d)); err != nil {
		t.Fatal(err)
	}
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Files: []library.File{
		{Identity: library.Identity{Source: "upload", ExternalID: "lease"}, BLAKE3: d, Filename: "lease-signed.pdf", SizeBytes: 1},
	}}); err != nil {
		t.Fatal(err)
	}
	if err := st.PutBlobText(ctx, store.BlobText{BLAKE3: d, Text: "pemberley lease agreement", Status: "ok"}); err != nil {
		t.Fatal(err)
	}
	const volume = "00000000-0000-0000-0000-000000000001"
	storetest.Exec(t, dsn, `
		insert into volumes(id,label,fs_type,serial,stable_ids) values ('`+volume+`','Archive','TEST','1',true);
		insert into scans(id,volume_id,root,status) overriding system value values (1,'`+volume+`','','complete')`)
	storetest.Exec(t, dsn, `
		insert into entries(id,volume_id,parent_id,kind,name,raw_name,path,size_bytes,content_id,hash_state,first_scan,updated_scan) overriding system value values
			(1,'`+volume+`',null,'dir','',''::bytea,'',0,null,'none',1,1),
			(2,'`+volume+`',1,'file','lease.pdf','lease.pdf'::bytea,'/lease.pdf',1,(select id from contents where blake3 = $1),'done',1,1)`, d)

	found := find(t, st, dsn, "pemberley lease", search.All, search.Filters{}, 20, 0)
	if len(found.Hits) != 1 {
		t.Fatalf("hits %+v, want the one content", found.Hits)
	}
	hit := found.Hits[0]
	var kinds []string
	for _, p := range hit.Places {
		kinds = append(kinds, p.Kind)
	}
	if hit.Kind != search.KindFile || hit.Ref != "content:"+d.String()[:16] || hit.PlaceCount != 3 ||
		!slices.Equal(kinds, []string{"message", "library_file", "disk"}) {
		t.Fatalf("hit %+v with places %q, want content:%s in a message, the library and on a disk", hit, kinds, d.String()[:16])
	}
}

// A filter narrows the ranked list inside the index, so the page asked for
// is the page of the filtered list.
func TestAFilteredSearchReturnsTheRightPage(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	start := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	var gmail []string
	for i := range 24 {
		source := []string{"gmail", "whatsapp"}[i%2]
		id, err := st.InsertMessage(ctx, store.Message{Source: source, ExternalID: string(rune('a' + i)),
			Body: "the quarterly report", SentAt: start.Add(time.Duration(i) * time.Hour)})
		if err != nil {
			t.Fatal(err)
		}
		if source == "gmail" {
			m, _, err := st.GetMessage(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			gmail = append([]string{m.Ref}, gmail...)
		}
	}
	// Ten gmail messages were sent from hour 4 on; newest first, the second
	// page of three is the fourth to sixth.
	found := find(t, st, dsn, "quarterly", search.All, search.Filters{Source: "gmail", Since: start.Add(4 * time.Hour)}, 3, 3)
	var got []string
	for _, h := range found.Hits {
		got = append(got, h.Ref)
	}
	if want := gmail[3:6]; !slices.Equal(got, want) {
		t.Fatalf("page %q, want %q", got, want)
	}
	if len(found.Counts) != 1 || found.Counts[0] != (search.KindCount{Kind: search.KindMessage, Matches: 10}) {
		t.Fatalf("counts %+v, want 10 messages", found.Counts)
	}
}

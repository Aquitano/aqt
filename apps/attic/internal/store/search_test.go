package store_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/apps/attic/internal/storetest"
	"github.com/jackc/pgx/v5"
)

func searchFixture(t *testing.T) (*store.Store, *pgx.Conn) {
	t.Helper()
	st, dsn := storetest.New(t)
	conn, err := pgx.Connect(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(t.Context()) })
	_, err = conn.Exec(t.Context(), `
 insert into volumes (id,label,fs_type,serial,stable_ids) values
 ('00000000-0000-0000-0000-000000000001','Search','TEST','one',false),
 ('00000000-0000-0000-0000-000000000002','Other','TEST','two',false);
 insert into scans (id,volume_id,root,status) overriding system value values
 (1,'00000000-0000-0000-0000-000000000001','','complete');
 insert into contents (id,blake3,size_bytes) overriding system value values
 (1,decode(repeat('11',32),'hex'),10), (2,decode(repeat('22',32),'hex'),20);
 insert into entries (id,volume_id,parent_id,kind,name,raw_name,path,ext,content_id,hash_state,first_scan,updated_scan) overriding system value values
 (1,'00000000-0000-0000-0000-000000000001',null,'dir','',''::bytea,'', '',null,'none',1,1),
 (2,'00000000-0000-0000-0000-000000000002',null,'dir','',''::bytea,'', '',null,'none',1,1),
 (3,'00000000-0000-0000-0000-000000000001',1,'file','Tom & Jerry.pdf','Tom & Jerry.pdf'::bytea,'/docs/Tom & Jerry.pdf','pdf',1,'done',1,1),
 (4,'00000000-0000-0000-0000-000000000001',1,'file','bundle.zip','bundle.zip'::bytea,'/docs/bundle.zip','zip',2,'done',1,1),
 (5,'00000000-0000-0000-0000-000000000001',1,'file','copy.jpg','copy.jpg'::bytea,'/else/copy.jpg','jpg',1,'done',1,1),
 (6,'00000000-0000-0000-0000-000000000002',2,'file','copy.pdf','copy.pdf'::bytea,'/docs/copy.pdf','pdf',1,'done',1,1);
 insert into archives(content_id,status) values(2,'listed');
 insert into members(archive_id,kind,name,path,ext) values(2,'file','Tom & Jerry.pdf','Tom & Jerry.pdf','pdf');
 insert into texts(content_id,status,text) values(1,'ok','Tom & Jerry');
 insert into metadata(content_id,status,tags,text) values(1,'ok','{}','Tom & Jerry');
 insert into ai_results(content_id,task,provider,model,prompt_version,status,text) values
 (1,'describe','test','one','v1','ok','Tom & Jerry'),
 (1,'ocr','test','two','v2','truncated','Tom & Jerry'),
 (1,'describe','test','failed','v1','failed','Tom & Jerry');`)
	if err != nil {
		t.Fatal(err)
	}
	return st, conn
}

func TestSearchPunctuationAcrossResults(t *testing.T) {
	st, _ := searchFixture(t)
	for _, tc := range []struct {
		query   string
		anyWord bool
		matches int
	}{
		{"Tom Jerry", false, 1},
		{"Tom & Jerry", false, 1},
		{"Tom ++ Jerry", false, 1},
		{"absent & Jerry", false, 0},
		{"absent & Jerry", true, 1},
	} {
		t.Run(tc.query, func(t *testing.T) {
			o := store.SearchOptions{Query: tc.query, Any: tc.anyWord}
			entries, err := st.Search(t.Context(), o)
			if err != nil || len(entries) != tc.matches {
				t.Errorf("entries: %+v, %v", entries, err)
			}
			members, err := st.SearchMembers(t.Context(), o)
			if err != nil || len(members) != tc.matches {
				t.Errorf("members: %+v, %v", members, err)
			}
			texts, err := st.SearchTexts(t.Context(), o)
			if err != nil || len(texts) != tc.matches {
				t.Errorf("texts: %+v, %v", texts, err)
			}
			meta, err := st.SearchMetadata(t.Context(), o)
			if err != nil || len(meta) != tc.matches {
				t.Errorf("metadata: %+v, %v", meta, err)
			}
			ai, err := st.SearchAI(t.Context(), o)
			if err != nil || len(ai) != 2*tc.matches {
				t.Errorf("AI: %+v, %v", ai, err)
			}
		})
	}
	for _, anyWord := range []bool{false, true} {
		for _, query := range []string{"&", "++"} {
			o := store.SearchOptions{Query: query, Any: anyWord, VolumeID: "00000000-0000-0000-0000-000000000001"}
			entries, err := st.Search(t.Context(), o)
			if err != nil || len(entries) != 0 {
				t.Errorf("punctuation entries: %+v, %v", entries, err)
			}
			members, err := st.SearchMembers(t.Context(), o)
			if err != nil || len(members) != 0 {
				t.Errorf("punctuation members: %+v, %v", members, err)
			}
			texts, err := st.SearchTexts(t.Context(), o)
			if err != nil || len(texts) != 0 {
				t.Errorf("punctuation texts: %+v, %v", texts, err)
			}
			meta, err := st.SearchMetadata(t.Context(), o)
			if err != nil || len(meta) != 0 {
				t.Errorf("punctuation metadata: %+v, %v", meta, err)
			}
			ai, err := st.SearchAI(t.Context(), o)
			if err != nil || len(ai) != 0 {
				t.Errorf("punctuation AI: %+v, %v", ai, err)
			}
		}
	}
}

func TestContentLookupsKeepResultSemantics(t *testing.T) {
	st, conn := searchFixture(t)
	_, err := conn.Exec(t.Context(), `insert into contents(id,blake3,size_bytes) overriding system value values(3,decode(repeat('11',8)||repeat('33',24),'hex'),30);
 insert into texts(content_id,status,text) values(3,'ok','collision');
 insert into metadata(content_id,status,tags,text) values(3,'ok','{}','collision');
 insert into ai_results(content_id,task,provider,model,prompt_version,status,text) values(3,'describe','test','collision','v1','ok','collision');`)
	if err != nil {
		t.Fatal(err)
	}
	ref := "attic:" + strings.Repeat("11", 8)
	for _, entryID := range []int64{0, 3} {
		text, err := st.Text(t.Context(), entryID, ref)
		if err != nil || text.Text != "Tom & Jerry" {
			t.Errorf("text: %+v, %v", text, err)
		}
		meta, err := st.Metadata(t.Context(), entryID, ref)
		if err != nil || meta.Status != "ok" {
			t.Errorf("metadata: %+v, %v", meta, err)
		}
		analyses, err := st.Analyses(t.Context(), entryID, ref)
		want := 3
		if entryID == 0 {
			want = 4
		}
		if err != nil || len(analyses) != want {
			t.Errorf("analyses: %+v, %v", analyses, err)
		}
	}
	if _, err := conn.Exec(t.Context(), `delete from texts where content_id=1; delete from metadata where content_id=1`); err != nil {
		t.Fatal(err)
	}
	text, err := st.Text(t.Context(), 0, ref)
	if err != nil || text.Text != "collision" {
		t.Errorf("text ref must select a content with text: %+v, %v", text, err)
	}
	meta, err := st.Metadata(t.Context(), 0, ref)
	if err != nil || meta.Status != "ok" {
		t.Errorf("metadata ref must select a content with metadata: %+v, %v", meta, err)
	}

	for _, entryID := range []int64{3, 4, 999} {
		if _, err := st.Text(t.Context(), entryID, ""); !errors.Is(err, store.ErrNotFound) || !strings.Contains(err.Error(), "no text read") {
			t.Errorf("text missing: %v", err)
		}
		if _, err := st.Metadata(t.Context(), entryID, ""); !errors.Is(err, store.ErrNotFound) || !strings.Contains(err.Error(), "no metadata read") {
			t.Errorf("metadata missing: %v", err)
		}
	}
	for _, entryID := range []int64{4, 999} {
		if got, err := st.Analyses(t.Context(), entryID, ""); err != nil || len(got) != 0 {
			t.Errorf("analyses missing: %+v, %v", got, err)
		}
	}
	if _, err := st.Text(t.Context(), 0, "invalid"); err == nil {
		t.Error("invalid text ref accepted")
	}
	if _, err := st.Metadata(t.Context(), 0, "invalid"); err == nil {
		t.Error("invalid metadata ref accepted")
	}
	if _, err := st.Analyses(t.Context(), 0, "invalid"); err == nil {
		t.Error("invalid AI ref accepted")
	}
}

func TestSearchUsesIndexedTerms(t *testing.T) {
	st, conn := searchFixture(t)
	_, err := conn.Exec(t.Context(), `update entries set name='東京 C++ a+ foo-bar Werkstudentenvertrag !!!.pdf',path='/docs/東京 C++ a+ foo-bar Werkstudentenvertrag !!!.pdf' where id=3;
 update members set name='東京 C++ a+ foo-bar Werkstudentenvertrag !!!.pdf',path='東京 C++ a+ foo-bar Werkstudentenvertrag !!!.pdf';
 update texts set text='東京 C++ a+ foo-bar Werkstudentenvertrag !!!';
 update metadata set text='東京 C++ a+ foo-bar Werkstudentenvertrag !!!';
 update ai_results set text='東京 C++ a+ foo-bar Werkstudentenvertrag !!!';`)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		query       string
		textMatches int
	}{
		{"東京 &", 1}, {"C++", 1}, {"a+", 1}, {"oo-b", 0}, {"werkstudent", 0}, {"!!!", 0},
	} {
		t.Run(tc.query, func(t *testing.T) {
			o := store.SearchOptions{Query: tc.query}
			entries, err := st.Search(t.Context(), o)
			if err != nil || len(entries) != 1 {
				t.Errorf("entries: %+v, %v", entries, err)
			}
			members, err := st.SearchMembers(t.Context(), o)
			if err != nil || len(members) != 1 {
				t.Errorf("members: %+v, %v", members, err)
			}
			texts, err := st.SearchTexts(t.Context(), o)
			if err != nil || len(texts) != tc.textMatches {
				t.Errorf("texts: %+v, %v", texts, err)
			}
			meta, err := st.SearchMetadata(t.Context(), o)
			if err != nil || len(meta) != tc.textMatches {
				t.Errorf("metadata: %+v, %v", meta, err)
			}
			ai, err := st.SearchAI(t.Context(), o)
			if err != nil || len(ai) != tc.textMatches*2 {
				t.Errorf("AI: %+v, %v", ai, err)
			}
		})
	}
}

func TestSearchFiltersAndAIProvenance(t *testing.T) {
	st, conn := searchFixture(t)
	_, err := conn.Exec(t.Context(), `insert into entries(id,volume_id,parent_id,kind,name,raw_name,path,ext,content_id,hash_state,first_scan,updated_scan) overriding system value values
 (7,'00000000-0000-0000-0000-000000000002',2,'file','copy.zip','copy.zip'::bytea,'/docs/copy.zip','zip',2,'done',1,1);`)
	if err != nil {
		t.Fatal(err)
	}
	o := store.SearchOptions{Query: "Tom & Jerry", VolumeID: "00000000-0000-0000-0000-000000000001", Under: "/docs/", Ext: ".PDF", Kind: "file"}
	entries, err := st.Search(t.Context(), o)
	if err != nil || len(entries) != 1 || entries[0].ID != 3 {
		t.Fatalf("entries: %+v, %v", entries, err)
	}
	members, err := st.SearchMembers(t.Context(), o)
	if err != nil || len(members) != 1 || len(members[0].Archive) != 1 || members[0].Archive[0].ID != 4 {
		t.Fatalf("members: %+v, %v", members, err)
	}
	texts, err := st.SearchTexts(t.Context(), o)
	if err != nil || len(texts) != 1 || len(texts[0].Places) != 1 || texts[0].Places[0].ID != 3 {
		t.Fatalf("texts: %+v, %v", texts, err)
	}
	meta, err := st.SearchMetadata(t.Context(), o)
	if err != nil || len(meta) != 1 || len(meta[0].Places) != 1 || meta[0].Places[0].ID != 3 {
		t.Fatalf("metadata: %+v, %v", meta, err)
	}
	analyses, err := st.SearchAI(t.Context(), o)
	if err != nil || len(analyses) != 2 {
		t.Fatalf("AI: %+v, %v", analyses, err)
	}
	for _, h := range analyses {
		if h.Provider != "test" || h.Ref != strings.Repeat("11", 8) || h.Snippet != "Tom & Jerry" || len(h.Places) != 1 || h.Places[0].ID != 3 {
			t.Errorf("AI provenance: %+v", h)
		}
		if (h.Task == "describe" && (h.Model != "one" || h.PromptVersion != "v1")) || (h.Task == "ocr" && (h.Model != "two" || h.PromptVersion != "v2")) {
			t.Errorf("AI policy: %+v", h)
		}
	}
	o.Under = "/docs/bundle.zip"
	members, err = st.SearchMembers(t.Context(), o)
	if err != nil || len(members) != 1 || len(members[0].Archive) != 1 || members[0].Archive[0].ID != 4 {
		t.Fatalf("archive self: %+v, %v", members, err)
	}
	o.Query = ""
	o.Under = "/"
	o.Kind = ""
	o.Ext = ""
	entries, err = st.Search(t.Context(), o)
	if err != nil || len(entries) != 3 {
		t.Errorf("volume root descendants: %+v, %v", entries, err)
	}
}

func TestSearchExplicitNoExtension(t *testing.T) {
	st, conn := searchFixture(t)
	_, err := conn.Exec(t.Context(), `update entries set name='Tom',path='/else/Tom',ext='' where id=5;
 insert into members(archive_id,kind,name,path,ext) values(2,'file','Tom','Tom','');`)
	if err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"", "Tom"} {
		for _, ext := range []string{"", "."} {
			t.Run("query="+query+"/ext="+ext, func(t *testing.T) {
				o := store.SearchOptions{Query: query, Ext: ext, Kind: "file"}
				wantEntries, wantMembers, wantPlaces := 1, 1, 1
				if query == "" && ext == "." {
					o.Kind = ""
					wantEntries = 3
				}
				if ext == "" {
					wantEntries, wantMembers, wantPlaces = 4, 2, 3
					if query != "" {
						wantEntries = 2
					}
				}
				entries, err := st.Search(t.Context(), o)
				if err != nil || len(entries) != wantEntries {
					t.Errorf("entries: %+v, %v", entries, err)
				}
				members, err := st.SearchMembers(t.Context(), o)
				if err != nil || len(members) != wantMembers {
					t.Fatalf("members: %+v, %v", members, err)
				}
				for _, member := range members {
					if len(member.Archive) != 1 || member.Archive[0].ID != 4 {
						t.Errorf("archive sources: %+v", member.Archive)
					}
				}
				if query == "" {
					return
				}
				texts, err := st.SearchTexts(t.Context(), o)
				if err != nil || len(texts) != 1 || len(texts[0].Places) != wantPlaces {
					t.Errorf("texts: %+v, %v", texts, err)
				}
				meta, err := st.SearchMetadata(t.Context(), o)
				if err != nil || len(meta) != 1 || len(meta[0].Places) != wantPlaces {
					t.Errorf("metadata: %+v, %v", meta, err)
				}
				ai, err := st.SearchAI(t.Context(), o)
				if err != nil || len(ai) != 2 {
					t.Fatalf("AI: %+v, %v", ai, err)
				}
				for _, hit := range ai {
					if len(hit.Places) != wantPlaces {
						t.Errorf("AI places: %+v", hit.Places)
					}
				}
			})
		}
	}
}

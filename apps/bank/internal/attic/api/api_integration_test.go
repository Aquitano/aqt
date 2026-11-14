package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/danielgtaylor/huma/v2/adapters/humago"
	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/bank/internal/attic/api"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/db"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/apps/bank/internal/tokens"
)

const volume = "00000000-0000-0000-0000-000000000001"

func TestAPIAnswersWithTaggedResults(t *testing.T) {
	_, dsn := storetest.NewCatalogue(t)
	ctx := t.Context()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	// Contents 2 and 3 share their first eight bytes, so ref 1111111111111111 names both.
	if _, err := conn.Exec(ctx, `
  insert into volumes(id,label,fs_type,serial,stable_ids) values ('`+volume+`','Archive','TEST','1',true);
  insert into scans(id,volume_id,root,status) overriding system value values (1,'`+volume+`','','complete');
  insert into contents(id,blake3,size_bytes) overriding system value values
   (1,decode(repeat('ab',32),'hex'),5),
   (2,decode(repeat('11',8)||repeat('22',24),'hex'),6),
   (3,decode(repeat('11',8)||repeat('33',24),'hex'),7);
  insert into entries(id,volume_id,parent_id,kind,name,raw_name,path,size_bytes,content_id,hash_state,missing_scan,first_scan,updated_scan) overriding system value values
   (1,'`+volume+`',null,'dir','',''::bytea,'',0,null,'none',null,1,1),
   (2,'`+volume+`',1,'file','minecraft-server.zip','minecraft-server.zip'::bytea,'/minecraft-server.zip',5,1,'done',null,1,1),
   (3,'`+volume+`',1,'file','a.txt','a.txt'::bytea,'/a.txt',6,2,'done',null,1,1),
   (4,'`+volume+`',1,'file','b.txt','b.txt'::bytea,'/b.txt',7,3,'done',null,1,1)`); err != nil {
		t.Fatal(err)
	}
	// The catalogue's routes only read, so the test reads through a read-only store.
	pool, err := db.OpenReadOnly(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	st := store.New(pool)
	issued := tokens.Store{Path: filepath.Join(t.TempDir(), "tokens")}
	token, err := issued.New("test", tokens.Read)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	humaAPI := humago.New(mux, httpapi.Config("test", "", "bank token new <name>"))
	humaAPI.UseMiddleware(httpapi.RequireToken(humaAPI, issued, "bank token new <name>"))
	api.Register(humaAPI, st, nil)
	server := httptest.NewServer(mux)
	defer server.Close()
	get := func(t *testing.T, path, token string, out any) int {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if err := json.NewDecoder(res.Body).Decode(out); err != nil {
			t.Fatalf("%s: decode: %v", path, err)
		}
		return res.StatusCode
	}

	for _, tc := range []struct {
		path, token string
		status      int
		tag         string
	}{
		{"/v1/disk/stats", "", http.StatusUnauthorized, "Unauthorized"},
		{"/v1/disk/stats", "bank_wrong", http.StatusUnauthorized, "Unauthorized"},
		{"/v1/disk/contents/content:ffffffffffffffff", token, http.StatusNotFound, "NotFound"},
		{"/v1/disk/contents/content:1111111111111111", token, http.StatusConflict, "AmbiguousRef"},
		{"/v1/disk/contents/xyz", token, http.StatusUnprocessableEntity, "InvalidRequest"},
		{"/v1/disk/contents/1111111111111111", token, http.StatusUnprocessableEntity, "InvalidRequest"},
		{"/v1/disk/contents/msg:1111111111111111", token, http.StatusUnprocessableEntity, "InvalidRequest"},
		{"/v1/disk/search?q=minecraft&limit=0", token, http.StatusUnprocessableEntity, "InvalidRequest"},
		{"/v1/disk/search?q=minecraft&offset=10001", token, http.StatusUnprocessableEntity, "InvalidRequest"},
		{"/v1/disk/search?q=minecraft&under=/x", token, http.StatusUnprocessableEntity, "InvalidRequest"},
		{"/v1/disk/search", token, http.StatusUnprocessableEntity, "InvalidRequest"},
		{"/v1/disk/search?q=%20", token, http.StatusUnprocessableEntity, "InvalidRequest"},
		{"/v1/disk/scans?limit=501", token, http.StatusUnprocessableEntity, "InvalidRequest"},
	} {
		var failure struct {
			Tag        string            `json:"_tag"`
			Message    string            `json:"message"`
			Ref        string            `json:"ref"`
			Candidates []json.RawMessage `json:"candidates"`
		}
		if status := get(t, tc.path, tc.token, &failure); status != tc.status || failure.Tag != tc.tag || failure.Message == "" {
			t.Errorf("%s: %d %+v, want %d %s with a message", tc.path, status, failure, tc.status, tc.tag)
		}
		if tc.tag == "AmbiguousRef" && (len(failure.Candidates) != 2 || failure.Ref != "content:1111111111111111") {
			t.Errorf("ambiguous ref %q lists %d candidates, want 2", failure.Ref, len(failure.Candidates))
		}
	}

	var found struct {
		Entries []json.RawMessage `json:"entries"`
	}
	if status := get(t, "/v1/disk/search?q=minecraft", token, &found); status != http.StatusOK || len(found.Entries) != 1 {
		t.Fatalf("search: %d %+v", status, found)
	}
	var hit struct {
		Path    string `json:"path"`
		Ref     string `json:"ref"`
		Display string `json:"display"`
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(found.Entries[0], &hit); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(found.Entries[0], &fields); err != nil {
		t.Fatal(err)
	}
	if _, online := fields["online"]; online || hit.Path != "/minecraft-server.zip" || hit.Ref != "content:abababababababab" || hit.Display != "Archive:"+string(filepath.Separator)+"minecraft-server.zip" {
		t.Errorf("search hit = %s, want no online field", found.Entries[0])
	}
	var content struct {
		Occurrences []struct {
			ID int64 `json:"id"`
		} `json:"occurrences"`
	}
	if status := get(t, "/v1/disk/contents/"+hit.Ref, token, &content); status != http.StatusOK || len(content.Occurrences) != 1 || content.Occurrences[0].ID != 2 {
		t.Errorf("content: %d %+v", status, content)
	}
}

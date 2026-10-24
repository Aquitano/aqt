package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/attic/internal/api"
	"github.com/aquitano/aqt/apps/attic/internal/config"
	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/apps/attic/internal/storetest"
)

const volume = "00000000-0000-0000-0000-000000000001"

func TestAPIAnswersWithTaggedResults(t *testing.T) {
	_, dsn := storetest.New(t)
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
	// attic serve reads through a read-only store; so does the test.
	st, err := store.OpenReadOnly(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	tokens := api.Tokens{Path: filepath.Join(t.TempDir(), "tokens")}
	token, err := tokens.New("test")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(api.New(st, config.Default(), tokens))
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
		{"/v1/stats", "", http.StatusUnauthorized, "Unauthorized"},
		{"/v1/stats", "attic_wrong", http.StatusUnauthorized, "Unauthorized"},
		{"/v1/contents/attic:ffffffffffffffff", token, http.StatusNotFound, "NotFound"},
		{"/v1/contents/1111111111111111", token, http.StatusConflict, "AmbiguousRef"},
		{"/v1/contents/xyz", token, http.StatusUnprocessableEntity, "InvalidRequest"},
		{"/v1/search?q=minecraft&limit=0", token, http.StatusUnprocessableEntity, "InvalidRequest"},
		{"/v1/search?q=minecraft&under=/x", token, http.StatusUnprocessableEntity, "InvalidRequest"},
		{"/v1/search", token, http.StatusUnprocessableEntity, "InvalidRequest"},
		{"/v1/search?q=%20", token, http.StatusUnprocessableEntity, "InvalidRequest"},
		{"/v1/contents/abababababababab/file", token, http.StatusConflict, "Unavailable"},
	} {
		var failure struct {
			Tag        string            `json:"_tag"`
			Message    string            `json:"message"`
			Recovery   *json.RawMessage  `json:"recovery"`
			Candidates []json.RawMessage `json:"candidates"`
			Volumes    []struct {
				ID    string `json:"id"`
				Label string `json:"label"`
			} `json:"volumes"`
		}
		if status := get(t, tc.path, tc.token, &failure); status != tc.status || failure.Tag != tc.tag || failure.Message == "" {
			t.Errorf("%s: %d %+v, want %d %s with a message", tc.path, status, failure, tc.status, tc.tag)
		}
		switch tc.tag {
		case "AmbiguousRef":
			if len(failure.Candidates) != 2 {
				t.Errorf("ambiguous ref lists %d candidates, want 2", len(failure.Candidates))
			}
		case "Unavailable":
			if len(failure.Volumes) != 1 || failure.Volumes[0].Label != "Archive" || failure.Recovery == nil {
				t.Errorf("unavailable download names %+v and recovery %v, want the Archive volume", failure.Volumes, failure.Recovery)
			}
		}
	}

	var found struct {
		Entries []struct {
			Path    string `json:"path"`
			Ref     string `json:"ref"`
			Display string `json:"display"`
			Online  bool   `json:"online"`
		} `json:"entries"`
	}
	if status := get(t, "/v1/search?q=minecraft", token, &found); status != http.StatusOK || len(found.Entries) != 1 {
		t.Fatalf("search: %d %+v", status, found)
	}
	hit := found.Entries[0]
	if hit.Path != "/minecraft-server.zip" || hit.Ref != "abababababababab" || hit.Online || hit.Display != "Archive:"+string(filepath.Separator)+"minecraft-server.zip" {
		t.Errorf("search hit = %+v", hit)
	}
	var content struct {
		Occurrences []struct {
			ID int64 `json:"id"`
		} `json:"occurrences"`
	}
	if status := get(t, "/v1/contents/attic:"+hit.Ref, token, &content); status != http.StatusOK || len(content.Occurrences) != 1 || content.Occurrences[0].ID != 2 {
		t.Errorf("content: %d %+v", status, content)
	}
}

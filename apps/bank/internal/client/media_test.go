package client

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

func TestLibraryClientUploadAndConflict(t *testing.T) {
	names := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Error("missing token")
		}
		switch r.URL.Path {
		case "/v1/library/files":
			if r.URL.Query().Get("item_id") != "item_test" {
				t.Error("missing item association")
			}
			reader, err := r.MultipartReader()
			if err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			for {
				part, err := reader.NextPart()
				if errors.Is(err, io.EOF) {
					break
				}
				if err != nil {
					t.Error(err)
					return
				}
				body, err := io.ReadAll(part)
				if err != nil {
					t.Error(err)
					return
				}
				if string(body) != part.FileName() {
					t.Errorf("file bytes: %q", body)
				}
				names = append(names, part.FileName())
			}
			json.NewEncoder(w).Encode([]library.File{{Filename: "one.txt"}, {Filename: "two.txt"}})
		case "/v1/library/items/item_test/state":
			w.WriteHeader(http.StatusConflict)
			io.WriteString(w, `{"code":"library_revision_conflict","error":"Reload"}`)
		case "/v1/find":
			if r.URL.Query().Get("kind") != "movie" || r.URL.Query().Get("match") != "phrase" || r.URL.Query().Get("from") != "alice" {
				t.Errorf("filters: %s", r.URL.RawQuery)
			}
			json.NewEncoder(w).Encode(catalog.Result{Messages: []store.Message{}, SearchResult: library.SearchResult{Items: []library.Item{{Title: "Movie"}}}})
		default:
			t.Errorf("unexpected route: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	c := New(server.URL, "secret")
	ctx := context.Background()
	dir := t.TempDir()
	paths := []string{}
	for _, name := range []string{"one.txt", "two.txt"} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, path)
	}
	files, err := c.UploadLibraryFiles(ctx, paths, "files", "owner", "item_test")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 || !reflect.DeepEqual(names, []string{"one.txt", "two.txt"}) {
		t.Fatalf("upload lost files: %+v %v", files, names)
	}
	if _, err = c.SetLibraryState(ctx, "item_test", library.StateEdit{}); !errors.Is(err, library.ErrConflict) {
		t.Fatalf("lost revision conflict: %v", err)
	}
	result, err := c.Find(ctx, "Movie", store.SearchOpts{Match: "phrase", From: "alice"}, library.ListOptions{Kind: "movie", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 {
		t.Fatalf("lost grouped results: %+v", result)
	}
}

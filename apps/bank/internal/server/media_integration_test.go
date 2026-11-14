package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/find"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/sources"
	"github.com/aquitano/aqt/apps/bank/internal/sources/media"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/tokens"
)

func libraryClient(t *testing.T) (*client.Client, *Server) {
	t.Helper()
	s, _ := attachmentServer(t)
	token, err := Tokens(s.dataDir).New("library-test", tokens.Write)
	if err != nil {
		t.Fatal(err)
	}
	host := httptest.NewServer(s.Handler())
	t.Cleanup(host.Close)
	return client.New(host.URL, token), s
}

func importUpload(ctx context.Context, c *client.Client, kind, name string, r io.Reader, options json.RawMessage) (store.RawInput, error) {
	k, err := sources.All.Lookup(kind)
	if err != nil {
		return store.RawInput{}, err
	}
	return client.Upload(ctx, c, ImportOp(k), ImportInput{}, client.ImportFile(name, r, options))
}

func uploadFiles(ctx context.Context, c *client.Client, paths []string, in UploadLibraryFilesInput) ([]library.File, error) {
	return client.Upload(ctx, c, UploadLibraryFiles, in, client.Files(paths))
}

// decoded reads a list whose shape the projection picked.
func decoded[T any](raw json.RawMessage, err error) (T, error) {
	var v T
	if err != nil {
		return v, err
	}
	return v, json.Unmarshal(raw, &v)
}

func paged(limit, offset int) httpapi.Page {
	return httpapi.Page{PageSize: httpapi.PageSize{Limit: limit}, Offset: offset}
}

func TestLibraryClientRoundTripPreservesFilesAndConflicts(t *testing.T) {
	ctx := context.Background()
	c, s := libraryClient(t)
	item, err := client.Call(ctx, c, CreateLibraryItem, CreateLibraryItemInput{Body: Strict[library.Item]{Value: library.Item{Kind: "book", Title: "Invoice guide"}}})
	if err != nil {
		t.Fatal(err)
	}
	rating := 4
	edit := library.StateEdit{Status: "planned", Rating: &rating, Notes: "Useful reference", Tags: []string{"reference"}}
	state, err := client.Call(ctx, c, SetLibraryItemState, LibraryStateInput{ID: item.ID, Body: Strict[library.StateEdit]{Value: edit}})
	if err != nil || state.Revision != 1 {
		t.Fatalf("state: %+v %v", state, err)
	}
	if _, err = client.Call(ctx, c, SetLibraryItemState, LibraryStateInput{ID: item.ID, Body: Strict[library.StateEdit]{Value: edit}}); !errors.Is(err, library.ErrConflict) {
		t.Fatalf("stale edit: %v", err)
	}
	paths := []string{filepath.Join(t.TempDir(), "invoice.txt"), filepath.Join(t.TempDir(), "receipt.txt")}
	for _, path := range paths {
		if err = os.WriteFile(path, []byte("Invoice evidence for the library"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	files, err := uploadFiles(ctx, c, paths, UploadLibraryFilesInput{Source: "files", Account: "owner", ItemID: item.ID})
	if err != nil || len(files) != 2 {
		t.Fatalf("upload: %+v %v", files, err)
	}
	if files[0].BLAKE3 != files[1].BLAKE3 || files[0].ID == files[1].ID {
		t.Fatalf("file occurrences versus shared bytes: %+v", files)
	}
	if _, err = uploadFiles(ctx, c, paths, UploadLibraryFilesInput{Source: "files", Account: "owner", ItemID: item.ID}); err != nil {
		t.Fatalf("repeat upload: %v", err)
	}
	item, err = client.Call(ctx, c, GetLibraryItem, LibraryIDInput{ID: item.ID})
	if err != nil || len(item.FileIDs) != 2 {
		t.Fatalf("associations: %+v %v", item, err)
	}
	if _, err = os.Stat(s.blobs.Path(files[0].BLAKE3)); err != nil {
		t.Fatal(err)
	}
	collection, err := client.Call(ctx, c, CreateLibraryCollection, CreateLibraryCollectionInput{Body: Strict[library.Collection]{Value: library.Collection{Kind: "watchlist", Title: "Invoice reading", Snapshot: &library.Snapshot{Entries: []library.Entry{{ItemID: item.ID, Position: 0}, {ItemID: item.ID, Position: 1}}}}}})
	if err != nil || len(collection.Snapshot.Entries) != 2 {
		t.Fatalf("duplicate entries: %+v %v", collection, err)
	}
	_, err = client.Call(ctx, c, EditLibraryCollection, CollectionEditInput{ID: collection.ID, Body: Strict[library.CollectionEdit]{Value: library.CollectionEdit{ExpectedRevision: collection.Revision, Title: "Invoice reading", Entries: []library.Entry{{ItemID: item.ID, Position: 0}}}}})
	if err != nil {
		t.Fatal(err)
	}
	snapshots, err := decoded[[]library.Snapshot](client.Call(ctx, c, ListLibraryCollectionSnapshots, SnapshotsInput{ID: collection.ID, Projection: "full"}))
	if err != nil || len(snapshots) != 2 {
		t.Fatalf("snapshot history: %+v %v", snapshots, err)
	}
	// What the upload's text job stores. receipt.txt and invoice.txt hold the
	// same bytes, so they are one file hit with two places.
	if err = s.db.PutBlobText(ctx, store.BlobText{BLAKE3: files[0].BLAKE3, Text: "Invoice evidence for the library", Status: "ok"}); err != nil {
		t.Fatal(err)
	}
	kinds := func(result find.Result) map[string]int {
		n := map[string]int{}
		for _, h := range result.Hits {
			n[h.Kind]++
		}
		return n
	}
	result, err := client.Call(ctx, c, Search, SearchInput{Q: "invoice", Page: paged(20, 0)})
	if found := kinds(result); err != nil || found["message"] != 1 || found["item"] != 1 || found["file"] != 1 || found["collection"] != 1 || result.Hits[0].PlaceCount != 2 {
		t.Fatalf("combined search: %+v %v", result, err)
	}
	result, err = client.Call(ctx, c, Search, SearchInput{Q: "scan.pdf", Kind: "file", Page: paged(20, 0)})
	if found := kinds(result); err != nil || found["file"] != 1 || len(result.Hits) != 1 {
		t.Fatalf("existing attachment name: %+v %v", result, err)
	}
	result, err = client.Call(ctx, c, Search, SearchInput{Q: "invoice", Page: paged(20, 0), From: "alice@example.com"})
	if found := kinds(result); err != nil || found["message"] != 1 || found["item"] != 0 {
		t.Fatalf("mail-specific filter: %+v %v", result, err)
	}
}

func TestLibraryRemoteImportsAndMarkdownRetraction(t *testing.T) {
	ctx := context.Background()
	c, _ := libraryClient(t)
	history := "Title,Date\nExample: Season 1: Pilot,2025-04-03\nExample: Season 1: Pilot,2025-04-03\n"
	netflix := json.RawMessage(`{"account": "profile-one"}`)
	raw, err := importUpload(ctx, c, "netflix", "NetflixViewingHistory.csv", strings.NewReader(history), netflix)
	if err != nil || raw.Report.Library.Activity != 2 || raw.Report.Library.Items != 1 {
		t.Fatalf("Netflix import: %+v %v", raw, err)
	}
	raw, err = importUpload(ctx, c, "netflix", "NetflixViewingHistory.csv", strings.NewReader(history), netflix)
	if err != nil || raw.Report.Library.Activity != 0 {
		t.Fatalf("Netflix replay: %+v %v", raw, err)
	}
	activity, err := client.Call(ctx, c, ListLibraryActivity, LibraryFilters{Source: "netflix", Account: "profile-one", Page: paged(20, 0)})
	if err != nil || len(activity) != 2 || activity[0].Occurred.Precision != "day" {
		t.Fatalf("Netflix precision: %+v %v", activity, err)
	}
	root := t.TempDir()
	path := filepath.Join(root, "page.md")
	publish := func() store.RawInput {
		t.Helper()
		publication, err := media.BuildPublication(root, media.PublicationOptions{Source: "brain", Account: "wiki"})
		if err != nil {
			t.Fatal(err)
		}
		document, err := json.Marshal(publication)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := importUpload(ctx, c, "markdown", "publication.json", bytes.NewReader(document), nil)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	if err = os.WriteFile(path, []byte("---\ntitle: Film notes\nanswers:\n  - Where is the violet telescope?\nsensitivity: normal\n---\nThe film has a memorable ending.\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if raw = publish(); raw.Report.Library.Pages != 1 {
		t.Fatalf("publication: %+v", raw)
	}
	found, err := client.Call(ctx, c, Search, SearchInput{Q: "violet telescope", Kind: "page", Page: paged(20, 0)})
	if err != nil || len(found.Hits) != 1 {
		t.Fatalf("Markdown answers: %+v %v", found, err)
	}
	if err = os.WriteFile(path, []byte("---\ntitle: Film notes\nsensitivity: confidential\n---\nPrivate.\n"), 0600); err != nil {
		t.Fatal(err)
	}
	publish()
	found, err = client.Call(ctx, c, Search, SearchInput{Q: "violet telescope", Kind: "page", Page: paged(20, 0)})
	if err != nil || len(found.Hits) != 0 {
		t.Fatalf("revoked page is still searchable: %+v %v", found, err)
	}
}

func TestLibraryRejectsUnauthenticatedWrites(t *testing.T) {
	_, s := libraryClient(t)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/library/files", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("got %d", w.Code)
	}
}

// Every field the upload names is checked before the first part is read, so
// a refused upload leaves no blob that no row refers to.
func TestLibraryUploadWithABadFieldStoresNoBlob(t *testing.T) {
	_, s := libraryClient(t)
	for _, query := range []string{"source=../escape", "item_id=item:00000000000000000000000000000000"} {
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		part, err := form.CreateFormFile("file", "notes.txt")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(part, "bytes nothing should keep"); err != nil {
			t.Fatal(err)
		}
		if err := form.Close(); err != nil {
			t.Fatal(err)
		}
		token, err := Tokens(s.dataDir).New("upload-"+rand.Text(), tokens.Write)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodPost, "/v1/library/files?"+query, &body)
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", form.FormDataContentType())
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != http.StatusUnprocessableEntity && w.Code != http.StatusNotFound {
			t.Fatalf("%s: %d %s", query, w.Code, w.Body)
		}
	}
	err := filepath.WalkDir(filepath.Join(s.dataDir, "blobs"), func(path string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			t.Errorf("a refused upload stored %s", path)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}

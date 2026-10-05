package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/mediaimport"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

func libraryClient(t *testing.T) (*client.Client, *Server) {
	t.Helper()
	s, _ := attachmentServer(t)
	token, err := NewToken(s.dataDir, "library-test")
	if err != nil {
		t.Fatal(err)
	}
	host := httptest.NewServer(s.Handler())
	t.Cleanup(host.Close)
	return client.New(host.URL, token), s
}

func TestLibraryClientRoundTripPreservesFilesAndConflicts(t *testing.T) {
	ctx := context.Background()
	c, s := libraryClient(t)
	item, err := c.CreateLibraryItem(ctx, library.Item{Kind: "book", Title: "Invoice guide"})
	if err != nil {
		t.Fatal(err)
	}
	rating := 4
	edit := library.StateEdit{Status: "planned", Rating: &rating, Notes: "Useful reference", Tags: []string{"reference"}}
	state, err := c.SetLibraryState(ctx, item.ID, edit)
	if err != nil || state.Revision != 1 {
		t.Fatalf("state: %+v %v", state, err)
	}
	if _, err = c.SetLibraryState(ctx, item.ID, edit); !errors.Is(err, library.ErrConflict) {
		t.Fatalf("stale edit: %v", err)
	}
	paths := []string{filepath.Join(t.TempDir(), "invoice.txt"), filepath.Join(t.TempDir(), "receipt.txt")}
	for _, path := range paths {
		if err = os.WriteFile(path, []byte("Invoice evidence for the library"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	files, err := c.UploadLibraryFiles(ctx, paths, "files", "owner", item.ID)
	if err != nil || len(files) != 2 {
		t.Fatalf("upload: %+v %v", files, err)
	}
	if files[0].SHA256 != files[1].SHA256 || files[0].ID == files[1].ID {
		t.Fatalf("file occurrences versus shared bytes: %+v", files)
	}
	if _, err = c.UploadLibraryFiles(ctx, paths, "files", "owner", item.ID); err != nil {
		t.Fatalf("repeat upload: %v", err)
	}
	item, err = c.LibraryItem(ctx, item.ID)
	if err != nil || len(item.FileIDs) != 2 {
		t.Fatalf("associations: %+v %v", item, err)
	}
	if _, err = os.Stat(s.blobs.Path(files[0].SHA256)); err != nil {
		t.Fatal(err)
	}
	collection, err := c.CreateLibraryCollection(ctx, library.Collection{Kind: "watchlist", Title: "Invoice reading", Snapshot: &library.Snapshot{Entries: []library.Entry{{ItemID: item.ID, Position: 0}, {ItemID: item.ID, Position: 1}}}})
	if err != nil || len(collection.Snapshot.Entries) != 2 {
		t.Fatalf("duplicate entries: %+v %v", collection, err)
	}
	_, err = c.EditLibraryCollection(ctx, collection.ID, library.CollectionEdit{ExpectedRevision: collection.Revision, Title: "Invoice reading", Entries: []library.Entry{{ItemID: item.ID, Position: 0}}})
	if err != nil {
		t.Fatal(err)
	}
	snapshots, err := c.LibraryCollectionSnapshots(ctx, collection.ID)
	if err != nil || len(snapshots) != 2 {
		t.Fatalf("snapshot history: %+v %v", snapshots, err)
	}
	s.extraction.done.Wait()
	result, err := c.Find(ctx, "invoice", store.SearchOpts{Limit: 20}, library.ListOptions{Limit: 20})
	if err != nil || len(result.Messages) != 1 || len(result.Items) != 1 || len(result.Files) != 2 || len(result.Collections) != 1 {
		t.Fatalf("combined search: %+v %v", result, err)
	}
	result, err = c.Find(ctx, "scan.pdf", store.SearchOpts{Limit: 20}, library.ListOptions{Kind: "file", Limit: 20})
	if err != nil || len(result.Attachments) != 1 {
		t.Fatalf("existing attachment name: %+v %v", result, err)
	}
	result, err = c.Find(ctx, "invoice", store.SearchOpts{Limit: 20, From: "alice@example.com"}, library.ListOptions{Limit: 20})
	if err != nil || len(result.Messages) != 1 || len(result.Items) != 0 {
		t.Fatalf("mail-specific filter: %+v %v", result, err)
	}
}

func TestLibraryRemoteImportsAndMarkdownRetraction(t *testing.T) {
	ctx := context.Background()
	c, _ := libraryClient(t)
	input := filepath.Join(t.TempDir(), "NetflixViewingHistory.csv")
	if err := os.WriteFile(input, []byte("Title,Date\nExample: Season 1: Pilot,2025-04-03\nExample: Season 1: Pilot,2025-04-03\n"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := c.ImportMediaFile(ctx, "netflix", "", "profile-one", input)
	if err != nil || result.Activity != 2 || result.Items != 1 {
		t.Fatalf("Netflix import: %+v %v", result, err)
	}
	result, err = c.ImportMediaFile(ctx, "netflix", "", "profile-one", input)
	if err != nil || result.Activity != 0 {
		t.Fatalf("Netflix replay: %+v %v", result, err)
	}
	activity, err := c.ListLibraryActivity(ctx, library.ListOptions{Source: "netflix", Account: "profile-one", Limit: 20})
	if err != nil || len(activity) != 2 || activity[0].Occurred.Precision != "day" {
		t.Fatalf("Netflix precision: %+v %v", activity, err)
	}
	root := t.TempDir()
	path := filepath.Join(root, "page.md")
	if err = os.WriteFile(path, []byte("---\ntitle: Film notes\nanswers:\n  - Where is the violet telescope?\nsensitivity: normal\n---\nThe film has a memorable ending.\n"), 0600); err != nil {
		t.Fatal(err)
	}
	publication, err := mediaimport.BuildPublication(root, mediaimport.Options{Source: "brain", Account: "wiki"})
	if err != nil {
		t.Fatal(err)
	}
	result, err = c.PublishLibraryPages(ctx, publication)
	if err != nil || result.Pages != 1 {
		t.Fatalf("publication: %+v %v", result, err)
	}
	found, err := c.Find(ctx, "violet telescope", store.SearchOpts{Limit: 20}, library.ListOptions{Limit: 20})
	if err != nil || len(found.Pages) != 1 {
		t.Fatalf("Markdown answers: %+v %v", found, err)
	}
	if err = os.WriteFile(path, []byte("---\ntitle: Film notes\nsensitivity: confidential\n---\nPrivate.\n"), 0600); err != nil {
		t.Fatal(err)
	}
	publication, err = mediaimport.BuildPublication(root, mediaimport.Options{Source: "brain", Account: "wiki"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = c.PublishLibraryPages(ctx, publication); err != nil {
		t.Fatal(err)
	}
	found, err = c.Find(ctx, "violet telescope", store.SearchOpts{Limit: 20}, library.ListOptions{Limit: 20})
	if err != nil || len(found.Pages) != 0 {
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

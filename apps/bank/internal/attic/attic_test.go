package attic_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/attic"
	"github.com/aquitano/aqt/apps/bank/internal/attic/api"
	"github.com/aquitano/aqt/apps/bank/internal/attic/storetest"
	"github.com/aquitano/aqt/apps/bank/internal/tokens"
)

func host(t *testing.T) (api.Host, string) {
	t.Helper()
	store := tokens.Store{Path: filepath.Join(t.TempDir(), "tokens")}
	token, err := store.New("test", tokens.Scope{})
	if err != nil {
		t.Fatal(err)
	}
	return api.Host{Tokens: store, MintCommand: "bank token new <name>", BasePath: "/attic"}, token
}

func stats(t *testing.T, url, token string) int {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url+"/attic/v1/stats", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

func TestHostKeepsServingWhileTheCatalogueCannotOpen(t *testing.T) {
	// Nothing listens here, so the migration fails.
	ctx, cancel := context.WithCancel(t.Context())
	catalogue := attic.Start(ctx, "postgres://attic:attic@127.0.0.1:1/attic?sslmode=disable&connect_timeout=1")
	defer catalogue.Close()
	defer cancel()
	h, token := host(t)
	server := httptest.NewServer(catalogue.Handler(h))
	defer server.Close()
	if status := stats(t, server.URL, token); status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", status)
	}
	if _, err := catalogue.SearchDisks(t.Context(), "report", 5, 0); err == nil {
		t.Fatal("search answered without a catalogue")
	}
}

func TestStartMigratesAnEmptyDatabaseThenServes(t *testing.T) {
	catalogue := attic.Start(t.Context(), storetest.Empty(t))
	defer catalogue.Close()
	h, token := host(t)
	server := httptest.NewServer(catalogue.Handler(h))
	defer server.Close()
	deadline := time.Now().Add(2 * time.Minute)
	for stats(t, server.URL, token) != http.StatusOK {
		if time.Now().After(deadline) {
			t.Fatal("the catalogue never became ready")
		}
		time.Sleep(100 * time.Millisecond)
	}
	if _, err := catalogue.SearchDisks(t.Context(), "report", 5, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := catalogue.ModifiedFiles(t.Context(), time.Unix(0, 0), time.Now(), 5); err != nil {
		t.Fatal(err)
	}
	if _, _, err := catalogue.ReadText(t.Context(), make([]byte, 32)); !errors.Is(err, attic.ErrNotFound) {
		t.Fatalf("text of bytes no disk holds: %v", err)
	}
	if _, err := catalogue.Content(t.Context(), "attic:0000000000000000"); !errors.Is(err, attic.ErrNotFound) {
		t.Fatalf("a ref no content has: %v", err)
	}
}

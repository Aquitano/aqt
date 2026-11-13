package attic_test

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/attic"
	"github.com/aquitano/aqt/apps/bank/internal/attic/api"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
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

func TestCatalogueServesAndSearches(t *testing.T) {
	st, _ := storetest.NewCatalogue(t)
	catalogue := attic.New(st)
	h, token := host(t)
	server := httptest.NewServer(catalogue.Handler(h))
	defer server.Close()
	if status := stats(t, server.URL, token); status != http.StatusOK {
		t.Fatalf("stats answered %d", status)
	}
	if _, err := catalogue.SearchDisks(t.Context(), "report", 5, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := catalogue.ModifiedFiles(t.Context(), time.Unix(0, 0), time.Now(), 5); err != nil {
		t.Fatal(err)
	}
	absent, err := ref.ParseContent("content:0000000000000000")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := catalogue.Content(t.Context(), absent); !errors.Is(err, attic.ErrNotFound) {
		t.Fatalf("a ref no content has: %v", err)
	}
}

package api_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/attic/api"
	"github.com/aquitano/aqt/apps/bank/internal/attic/config"
	"github.com/aquitano/aqt/apps/bank/internal/tokens"
)

func TestAPIMountsBelowAHostBasePath(t *testing.T) {
	host := api.Host{
		Tokens:      tokens.Store{Path: filepath.Join(t.TempDir(), "tokens")},
		MintCommand: "bank token new <name>",
		BasePath:    "/attic",
	}
	server := httptest.NewServer(api.New(nil, config.Default(), host))
	defer server.Close()
	get := func(path string) (int, string) {
		t.Helper()
		res, err := http.Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, string(body)
	}
	if status, body := get("/attic/openapi.json"); status != http.StatusOK || !strings.Contains(body, `"/attic"`) {
		t.Fatalf("spec under the base path: %d, servers missing /attic", status)
	}
	if status, body := get("/attic/v1/stats"); status != http.StatusUnauthorized || !strings.Contains(body, "bank token new") {
		t.Fatalf("unauthenticated request: %d %s", status, body)
	}
	if status, _ := get("/v1/stats"); status != http.StatusNotFound {
		t.Fatalf("route outside the base path answered %d", status)
	}
}

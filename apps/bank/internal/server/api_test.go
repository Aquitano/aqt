package server

import (
	"bytes"
	"os"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/sources"
)

// The committed document is the API contract reviewers and code-mode hosts read.
func TestCommittedSpecMatchesTheServer(t *testing.T) {
	spec, err := Spec(sources.All)
	if err != nil {
		t.Fatal(err)
	}
	committed, err := os.ReadFile("../../openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(bytes.TrimSpace(spec), bytes.TrimSpace(bytes.ReplaceAll(committed, []byte("\r\n"), []byte("\n")))) {
		t.Fatal("openapi.json is stale; regenerate it with: go run ./cmd/bank openapi > openapi.json")
	}
}

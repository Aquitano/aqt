package api

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/retrieve"
)

func TestUnavailableKeepsAnEmptyVolumeList(t *testing.T) {
	body, err := json.Marshal(fail(&retrieve.UnavailableError{}))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"volumes":[]`) {
		t.Fatalf("body = %s, want the documented empty volumes list", body)
	}
	other, err := json.Marshal(errNotFound.new("gone"))
	if err != nil || strings.Contains(string(other), "volumes") {
		t.Fatalf("a NotFound error carries volumes: %s %v", other, err)
	}
}

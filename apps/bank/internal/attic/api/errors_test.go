package api

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
)

func TestInternalFailuresKeepTheirCause(t *testing.T) {
	body, err := json.Marshal(failure(errors.New("dial tcp 10.0.0.5:5432: connection refused")))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "10.0.0.5") || !strings.Contains(string(body), `"_tag":"Internal"`) {
		t.Fatalf("body = %s, want Internal without the cause", body)
	}
	if body, _ = json.Marshal(failure(store.ErrNotFound)); !strings.Contains(string(body), `"_tag":"NotFound"`) {
		t.Fatalf("not found answered %s", body)
	}
}

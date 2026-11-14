package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alecthomas/kong"

	"github.com/aquitano/aqt/apps/bank/internal/inbox"
	"github.com/aquitano/aqt/apps/bank/internal/server"
	"github.com/aquitano/aqt/apps/bank/internal/sources"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// Registering a source is the whole of adding it: the CLI command, the
// server route, the inbox directory and replay all come from the registry.
func TestEveryRegisteredKindIsReachable(t *testing.T) {
	spec, err := server.Spec(sources.All)
	if err != nil {
		t.Fatal(err)
	}
	inboxDir := t.TempDir()
	settled := time.Now().Add(-time.Hour)
	for _, kind := range sources.All.Names() {
		path := filepath.Join(inboxDir, kind, "input")
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, settled, settled); err != nil {
			t.Fatal(err)
		}
	}
	var swept []string
	if _, err := inbox.Sweep(context.Background(), inboxDir, sources.All.Names(), func(_ context.Context, kind, _ string) (store.RawInput, error) {
		swept = append(swept, kind)
		return store.RawInput{}, nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, kind := range sources.All.Names() {
		trace, err := kong.Trace(newParser(newCLI()), []string{"import", kind, "input"})
		if err != nil || trace.Error != nil || trace.Selected() == nil || trace.Selected().Name != kind {
			t.Errorf("CLI: bank import %s: %v %v", kind, err, trace.Error)
		}
		if !strings.Contains(string(spec), `"/v1/import/`+kind+`"`) {
			t.Errorf("server: no route for %s", kind)
		}
		if !slices.Contains(swept, kind) {
			t.Errorf("inbox: %s was not swept", kind)
		}
		if _, err := sources.All.Lookup(kind); err != nil {
			t.Errorf("replay: %v", err)
		}
	}
}

func TestImportRejectsInvalidOptionsBeforeOpeningStore(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://nobody@127.0.0.1:1/none")
	err := execute(context.Background(), []string{"import", "netflix", "input.csv", "--date-order", "auto"})
	if err == nil || !strings.Contains(err.Error(), "date order") {
		t.Fatalf("invalid date order reached the importer: %v", err)
	}
}

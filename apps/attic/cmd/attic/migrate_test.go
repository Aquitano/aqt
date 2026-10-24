package main

import (
	"errors"
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/apps/attic/internal/storetest"
)

func TestReadCommandsWaitForMigrate(t *testing.T) {
	t.Setenv("DATABASE_URL", storetest.Empty(t))
	if err := execute(t.Context(), []string{"stats"}); !errors.Is(err, store.ErrCatalogueNotMigrated) {
		t.Fatalf("stats before migrate: %v", err)
	}
	if err := execute(t.Context(), []string{"migrate"}); err != nil {
		t.Fatal(err)
	}
	if err := execute(t.Context(), []string{"stats"}); err != nil {
		t.Fatalf("stats after migrate: %v", err)
	}
}

func TestScanMigrates(t *testing.T) {
	t.Setenv("DATABASE_URL", storetest.Empty(t))
	for _, dir := range []string{"APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"} {
		t.Setenv(dir, t.TempDir())
	}
	if err := execute(t.Context(), []string{"scan", t.TempDir(), "--no-hash"}); err != nil {
		t.Fatal(err)
	}
	if err := execute(t.Context(), []string{"stats"}); err != nil {
		t.Fatalf("stats after scan: %v", err)
	}
}

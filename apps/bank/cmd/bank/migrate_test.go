package main

import (
	"errors"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/db"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestCommandsWaitForMigrate(t *testing.T) {
	t.Setenv("BANK_URL", "")
	t.Setenv("BANK_QUERY_DATABASE_URL", "")
	t.Setenv("DATABASE_URL", storetest.NewEmpty(t))
	if err := execute(t.Context(), []string{"stats", "--json"}); !errors.Is(err, db.ErrBehind) {
		t.Fatalf("stats before migrate: %v", err)
	}
	if err := execute(t.Context(), []string{"migrate"}); err != nil {
		t.Fatal(err)
	}
	if err := execute(t.Context(), []string{"stats", "--json"}); err != nil {
		t.Fatalf("stats after migrate: %v", err)
	}
}

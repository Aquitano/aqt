// Package storetest gives integration tests a migrated Store on a database of
// its own, on the server TRACKER_TEST_DATABASE_URL names. Search, claiming and
// dedup all live in SQL, so a fake store would only prove the fake works.
package storetest

import (
	"context"
	"testing"

	"github.com/aquitano/aqt/apps/tracker/internal/store"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

var env = pgschematest.Env{URL: "TRACKER_TEST_DATABASE_URL", Require: "TRACKER_REQUIRE_DB"}

var migrator = pgschematest.Migrator(store.Migrations, func(ctx context.Context, dsn string) error {
	st, err := store.Open(ctx, dsn)
	if err != nil {
		return err
	}
	return st.Close()
})

func New(t *testing.T) *store.Store {
	t.Helper()
	st, _ := NewNamed(t)
	return st
}

// NewNamed also returns the database's URL, for assertions on rows the Store
// API does not expose.
func NewNamed(t *testing.T) (*store.Store, string) {
	t.Helper()
	dsn := pgschematest.Database(t, env, migrator)
	st, err := store.Open(context.Background(), dsn)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st, dsn
}

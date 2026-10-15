// Package storetest gives each integration test a migrated ParadeDB database
// on the server ATTIC_TEST_DATABASE_URL names. It creates databases there, so
// it never uses the application's DATABASE_URL.
package storetest

import (
	"context"
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

var env = pgschematest.Env{URL: "ATTIC_TEST_DATABASE_URL", Require: "ATTIC_REQUIRE_DB"}

var migrator = pgschematest.Migrator(store.Migrations, func(ctx context.Context, dsn string) error {
	st, err := store.Open(ctx, dsn)
	if err != nil {
		return err
	}
	st.Close()
	return nil
})

// New returns a Store and connection URL on a database cloned from a migrated
// template. A successful test drops its database; a failure preserves it.
func New(t *testing.T) (*store.Store, string) {
	t.Helper()
	dsn := pgschematest.Database(t, env, migrator)
	st, err := store.Open(context.Background(), dsn)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(st.Close)
	return st, dsn
}

// QueryInt runs a single-value integer query against the test's database.
var QueryInt = pgschematest.QueryInt

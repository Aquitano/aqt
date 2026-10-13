// Package storetest gives integration tests a migrated Store on a database of
// its own, which pgtestdb clones from a template migrated once per set of
// migrations, on the server TRACKER_TEST_DATABASE_URL points at. Search,
// claiming and dedup all live in SQL, so a fake store would only prove the
// fake works. Tests skip when the variable is unset.
package storetest

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/peterldowns/pgtestdb"
	"github.com/peterldowns/pgtestdb/migrators/common"
	"github.com/uptrace/bun/driver/pgdriver"

	"github.com/aquitano/aqt/apps/tracker/internal/store"
)

const EnvVar = "TRACKER_TEST_DATABASE_URL"

func New(t *testing.T) *store.Store {
	t.Helper()
	st, _ := NewNamed(t)
	return st
}

// NewNamed also returns the database's URL, for assertions on rows the Store
// API does not expose.
func NewNamed(t *testing.T) (*store.Store, string) {
	t.Helper()
	dsn := os.Getenv(EnvVar)
	if dsn == "" {
		t.Skipf("%s not set", EnvVar)
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("%s: %v", EnvVar, err)
	}
	password, _ := u.User.Password()
	db := pgtestdb.Custom(t, pgtestdb.Config{
		DriverName: "pg",
		Host:       u.Hostname(),
		Port:       u.Port(),
		User:       u.User.Username(),
		Password:   password,
		Database:   strings.TrimPrefix(u.Path, "/"),
		Options:    u.RawQuery,
	}, migrator{})
	st, err := store.Open(context.Background(), db.URL())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st, db.URL()
}

// migrator builds the template with store.Open, so it holds exactly what the
// server's own startup leaves behind.
type migrator struct{}

func (migrator) Hash() (string, error) {
	return common.HashDirs(store.Migrations, "*.sql", "migrations")
}

func (migrator) Migrate(ctx context.Context, _ *sql.DB, conf pgtestdb.Config) error {
	st, err := store.Open(ctx, conf.URL())
	if err != nil {
		return err
	}
	return st.Close()
}

// QueryInt runs a single-value query against the test's database, for
// assertions past the Store API.
func QueryInt(t *testing.T, dsn, query string, args ...any) int64 {
	t.Helper()
	db := sql.OpenDB(pgdriver.NewConnector(pgdriver.WithDSN(dsn)))
	defer db.Close()
	var n int64
	if err := db.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatalf("query: %v\n%s", err, query)
	}
	return n
}

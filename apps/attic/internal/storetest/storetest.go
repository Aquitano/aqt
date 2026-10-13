// Package storetest gives each integration test a migrated ParadeDB database.
package storetest

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/peterldowns/pgtestdb"
	"github.com/peterldowns/pgtestdb/migrators/common"

	"github.com/aquitano/aqt/apps/attic/internal/store"
)

const EnvVar = "ATTIC_TEST_DATABASE_URL"

// Config points pgtestdb at an explicitly selected disposable server. It
// creates databases and roles, so it never uses the application's DATABASE_URL.
func Config(t *testing.T) pgtestdb.Config {
	t.Helper()
	dsn := os.Getenv(EnvVar)
	if dsn == "" {
		if os.Getenv("ATTIC_REQUIRE_DB") == "1" || os.Getenv("CI") != "" {
			t.Fatalf("%s must name a disposable ParadeDB server", EnvVar)
		}
		t.Skipf("%s not set", EnvVar)
	}
	u, err := url.Parse(dsn)
	if err != nil || u.Scheme != "postgres" && u.Scheme != "postgresql" {
		t.Fatalf("%s must be a PostgreSQL URL", EnvVar)
	}
	conf, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse %s: %v", EnvVar, err)
	}
	return pgtestdb.Config{
		DriverName: "pgx", Host: conf.Host, Port: strconv.Itoa(int(conf.Port)),
		User: conf.User, Password: conf.Password, Database: conf.Database,
		Options: u.RawQuery,
	}
}

// New returns a Store and connection URL on a database cloned from a migrated
// template. A successful test drops its database; a failure preserves it.
func New(t *testing.T) (*store.Store, string) {
	t.Helper()
	db := pgtestdb.Custom(t, Config(t), migrator{})
	st, err := store.Open(context.Background(), db.URL())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(st.Close)
	return st, db.URL()
}

type migrator struct{}

func (migrator) Hash() (string, error) {
	hash, err := common.HashDirs(store.Migrations, "*.sql", "migrations")
	return "attic-tern-v1-" + hash, err
}

func (migrator) Migrate(ctx context.Context, _ *sql.DB, conf pgtestdb.Config) error {
	st, err := store.Open(ctx, conf.URL())
	if err != nil {
		return err
	}
	st.Close()
	return nil
}

// QueryInt runs a single-value integer query against the test's database.
func QueryInt(t *testing.T, dsn, sql string, args ...any) int64 {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)
	var n int64
	if err := conn.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
		t.Fatalf("query: %v\n%s", err, sql)
	}
	return n
}

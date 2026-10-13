// Package storetest gives tests a real ParadeDB to run against: pgtestdb clones
// a database per test from a template it migrates once. Search, migrations and
// dedup all live in SQL, so a fake store would only prove the fake works.
//
// Tests skip only when nothing is listening at all — the machine that has not
// started the compose stack. A database that answers and refuses (wrong
// password, missing database) fails the test instead: skipping there would
// silently disable every DB-backed test while `go test ./...` stays green.
package storetest

import (
	"context"
	"database/sql"
	"errors"
	"net"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/peterldowns/pgtestdb"
	"github.com/peterldowns/pgtestdb/migrators/common"

	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// DSN is the development database, matching the CLI's own default.
func DSN() string {
	if dsn := os.Getenv("DATABASE_URL"); dsn != "" {
		return dsn
	}
	return "postgres://bank:bank@localhost:5433/bank?sslmode=disable"
}

// New returns a Store on a migrated database of its own, dropped when the
// test passes.
func New(t *testing.T) *store.Store {
	t.Helper()
	st, _ := NewNamed(t)
	return st
}

// NewNamed is New plus the database's connection string, for tests that also
// need to reach past the Store API — to seed damage, or to assert on rows it
// does not expose.
func NewNamed(t *testing.T) (*store.Store, string) {
	t.Helper()
	dsn := database(t, migrator{})
	return Open(t, dsn), dsn
}

// NewEmpty returns a database no migration has touched, for tests that need
// to seed a pre-migration state before opening a Store.
func NewEmpty(t *testing.T) string {
	t.Helper()
	return database(t, pgtestdb.NoopMigrator{})
}

// Exec runs setup SQL against a test database before or beside a Store.
func Exec(t *testing.T, dsn, sql string, args ...any) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, sql, args...); err != nil {
		t.Fatalf("exec: %v\n%s", err, sql)
	}
}

// QueryInt runs a single-value integer query, for assertions about rows the
// Store API does not expose.
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

// Open migrates and returns a Store for an existing test database.
func Open(t *testing.T, dsn string) *store.Store {
	t.Helper()
	st, err := store.Open(context.Background(), dsn)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(st.Close)
	queryDSN := QueryDSN(t, dsn)
	Exec(t, dsn, `grant usage on schema public to bank_query_test; grant select on all tables in schema public to bank_query_test; grant select on all sequences in schema public to bank_query_test`)
	if err := st.ConfigureQuery(context.Background(), queryDSN); err != nil {
		t.Fatalf("query pool: %v", err)
	}
	return st
}

// CountAttachments answers "did anything get stored?" for tests that assert on
// the absence of rows.
func CountAttachments(t *testing.T, dsn string) int64 {
	t.Helper()
	return QueryInt(t, dsn, `select count(*) from attachments`)
}

func database(t *testing.T, m pgtestdb.Migrator) string {
	t.Helper()
	if err := reachable(); err != nil {
		if unreachable(err) && os.Getenv("BANK_REQUIRE_DB") != "1" && os.Getenv("CI") == "" {
			t.Skipf("no database at %s: %v", redacted(DSN()), err)
		}
		t.Fatalf("required database at %s is unavailable — fix DATABASE_URL rather than skipping DB-backed tests: %v",
			redacted(DSN()), err)
	}
	u, err := url.Parse(DSN())
	if err != nil {
		t.Fatalf("DATABASE_URL: %v", err)
	}
	password, _ := u.User.Password()
	// The test databases belong to the configured user, as the archive does in
	// production: a superuser that also provisions the query role.
	conf := pgtestdb.Config{
		DriverName:                "pgx",
		Host:                      u.Hostname(),
		Port:                      u.Port(),
		User:                      u.User.Username(),
		Password:                  password,
		Database:                  strings.TrimPrefix(u.Path, "/"),
		Options:                   u.RawQuery,
		TestRole:                  &pgtestdb.Role{Username: u.User.Username(), Password: password},
		ForceTerminateConnections: true,
	}
	return pgtestdb.Custom(t, conf, m).URL()
}

var reachable = sync.OnceValue(func() error {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, DSN())
	if err != nil {
		return err
	}
	return conn.Close(ctx)
})

// migrator builds the template every migrated test database is cloned from,
// through the same Open the binary runs at startup.
type migrator struct{}

func (migrator) Hash() (string, error) {
	hash, err := common.HashDirs(store.Migrations, "*.sql", ".")
	return "tern-v1-" + hash, err
}

func (migrator) Migrate(ctx context.Context, _ *sql.DB, conf pgtestdb.Config) error {
	st, err := store.Open(ctx, conf.URL())
	if err != nil {
		return err
	}
	st.Close()
	return nil
}

// unreachable reports whether a connect failure means nothing is listening —
// connection refused, unknown host. That is the one condition worth a skip.
func unreachable(err error) bool {
	var op *net.OpError
	var dns *net.DNSError
	return errors.As(err, &op) || errors.As(err, &dns)
}

func redacted(dsn string) string {
	if at := strings.LastIndex(dsn, "@"); at > 0 {
		if scheme := strings.Index(dsn, "//"); scheme > 0 && scheme+2 < at {
			return dsn[:scheme+2] + "***" + dsn[at:]
		}
	}
	return dsn
}

// QueryDSN authenticates as a real restricted login, never SET ROLE on the
// administrator connection. The advisory lock serializes package test binaries.
func QueryDSN(t *testing.T, dsn string) string {
	t.Helper()
	if err := provisionQueryRole(); err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	u.User = url.UserPassword("bank_query_test", "bank_query_test")
	return u.String()
}

var provisionQueryRole = sync.OnceValue(func() error {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, DSN())
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `select pg_advisory_xact_lock(726374293);
 do $$ begin
 if not exists (select from pg_roles where rolname = 'bank_query_test') then
 create role bank_query_test login password 'bank_query_test' nosuperuser nocreatedb nocreaterole noreplication nobypassrls;

 end if;
 end $$;
 revoke pg_read_all_data from bank_query_test;`)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
})

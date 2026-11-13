// Package storetest gives tests a real ParadeDB to run against: a database per
// test on the server BANK_TEST_DATABASE_URL names. It creates databases and
// roles there, so it never uses the application's DATABASE_URL. Search,
// migrations and dedup all live in SQL, so a fake store would only prove the
// fake works.
package storetest

import (
	"context"
	"net/url"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/peterldowns/pgtestdb"

	atticstore "github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/db"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

const urlVar = "BANK_TEST_DATABASE_URL"

var migrator = pgschematest.Migrator(db.Migrations, db.Migrate)

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
	dsn := Migrated(t)
	return Open(t, dsn), dsn
}

// Migrated returns the connection string of a migrated database of its own.
func Migrated(t *testing.T) string {
	t.Helper()
	return pgschematest.Database(t, urlVar, migrator)
}

// NewEmpty returns a database no migration has touched.
func NewEmpty(t *testing.T) string {
	t.Helper()
	return pgschematest.Database(t, urlVar, pgtestdb.NoopMigrator{})
}

// NewCatalogue returns the file catalogue's Store on a migrated database of
// its own, and the database's connection string.
func NewCatalogue(t *testing.T) (*atticstore.Store, string) {
	t.Helper()
	dsn := Migrated(t)
	return OpenCatalogue(t, dsn), dsn
}

// OpenCatalogue returns the file catalogue's Store on an existing test database.
func OpenCatalogue(t *testing.T, dsn string) *atticstore.Store {
	t.Helper()
	return atticstore.New(Pool(t, dsn))
}

// Pool opens a pool on an existing test database, closed when the test ends.
func Pool(t *testing.T, dsn string) *pgxpool.Pool {
	t.Helper()
	pool, err := db.Open(context.Background(), dsn)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
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

// Open returns a Store, with its query connection, for an existing test
// database.
func Open(t *testing.T, dsn string) *store.Store {
	t.Helper()
	st := store.New(Pool(t, dsn))
	t.Cleanup(st.CloseQuery)
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
	return pgschematest.QueryInt(t, dsn, `select count(*) from attachments`)
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
	conn, err := pgx.Connect(ctx, os.Getenv(urlVar))
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

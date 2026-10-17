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
	"github.com/peterldowns/pgtestdb"

	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

const urlVar = "BANK_TEST_DATABASE_URL"

var migrator = pgschematest.Migrator(store.Migrations, func(ctx context.Context, dsn string) error {
	st, err := store.Open(ctx, dsn)
	if err != nil {
		return err
	}
	st.Close()
	return nil
})

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
	dsn := pgschematest.Database(t, urlVar, migrator)
	return Open(t, dsn), dsn
}

// NewEmpty returns a database no migration has touched, for tests that need
// to seed a pre-migration state before opening a Store.
func NewEmpty(t *testing.T) string {
	t.Helper()
	return pgschematest.Database(t, urlVar, pgtestdb.NoopMigrator{})
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

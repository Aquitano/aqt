// Package storetest gives tests a real ParadeDB to run against, isolated in a
// throwaway schema. Search, migrations and dedup all live in SQL, so a fake
// store would only prove the fake works.
//
// Tests skip when no database is reachable, so `go test ./...` still passes on
// a machine that has not started the compose stack.
package storetest

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt-bank/internal/store"
)

var counter atomic.Int64

// DSN is the development database, matching the CLI's own default.
func DSN() string {
	if dsn := os.Getenv("DATABASE_URL"); dsn != "" {
		return dsn
	}
	return "postgres://bank:bank@localhost:5433/bank?sslmode=disable"
}

// New returns a migrated Store on a schema of its own, dropped when the test
// finishes.
func New(t *testing.T) *store.Store {
	t.Helper()
	st, _ := NewNamed(t)
	return st
}

// NewNamed is New plus the schema name, for tests that also need to reach past
// the Store API — to seed damage, or to assert on rows it does not expose.
func NewNamed(t *testing.T) (*store.Store, string) {
	t.Helper()
	schema := NewSchema(t)
	return open(t, SchemaDSN(t, schema)), schema
}

// NewSchema creates an empty schema and registers its cleanup, for tests that
// need to seed a pre-migration state before opening a Store.
func NewSchema(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, DSN())
	if err != nil {
		t.Skipf("no database at %s: %v", redacted(DSN()), err)
	}
	schema := fmt.Sprintf("banktest_%d_%d", os.Getpid(), counter.Add(1))
	if _, err := admin.Exec(ctx, "create schema "+schema); err != nil {
		admin.Close(ctx)
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(context.Background(), "drop schema "+schema+" cascade"); err != nil {
			t.Logf("drop schema %s: %v", schema, err)
		}
		admin.Close(context.Background())
	})
	return schema
}

// SchemaDSN points a connection string at one schema. public and paradedb stay
// on the path because the extension's operators live there.
func SchemaDSN(t *testing.T, schema string) string {
	t.Helper()
	u, err := url.Parse(DSN())
	if err != nil {
		t.Fatalf("DATABASE_URL: %v", err)
	}
	q := u.Query()
	q.Set("search_path", schema+",public,paradedb")
	u.RawQuery = q.Encode()
	return u.String()
}

// Exec runs setup SQL against a schema before or beside a Store.
func Exec(t *testing.T, schema, sql string, args ...any) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, SchemaDSN(t, schema))
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
func QueryInt(t *testing.T, schema, sql string, args ...any) int64 {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, SchemaDSN(t, schema))
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

// Open migrates and returns a Store for an existing schema.
func Open(t *testing.T, schema string) *store.Store {
	t.Helper()
	return open(t, SchemaDSN(t, schema))
}

func open(t *testing.T, dsn string) *store.Store {
	t.Helper()
	st, err := store.Open(context.Background(), dsn)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(st.Close)
	return st
}

func redacted(dsn string) string {
	if at := strings.LastIndex(dsn, "@"); at > 0 {
		if scheme := strings.Index(dsn, "//"); scheme > 0 && scheme+2 < at {
			return dsn[:scheme+2] + "***" + dsn[at:]
		}
	}
	return dsn
}

// CountAttachments answers "did anything get stored?" for tests that assert on
// the absence of rows.
func CountAttachments(t *testing.T, schema string) int64 {
	t.Helper()
	return QueryInt(t, schema, `select count(*) from attachments`)
}

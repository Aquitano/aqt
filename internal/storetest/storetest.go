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
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt-bank/internal/store"
)

var (
	counter atomic.Int64
	sweep   sync.Once
)

// schemaPrefix marks a schema as this package's to drop. The creation time is
// in the name because a schema has no catalog timestamp, and a test process
// that dies — a panic, a deliberately triggered data race — never runs its
// cleanup. Without a sweep those schemas accumulate in the developer's own
// database forever.
const schemaPrefix = "banktest_"

// staleAfter is comfortably longer than any test run, so a sweep can never
// remove a schema another run is still using.
const staleAfter = time.Hour

func dropStaleSchemas(t *testing.T, conn *pgx.Conn) {
	ctx := context.Background()
	rows, err := conn.Query(ctx,
		`select nspname from pg_namespace where nspname like $1`, schemaPrefix+"%")
	if err != nil {
		return
	}
	var stale []string
	cutoff := time.Now().Add(-staleAfter).Unix()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			continue
		}
		parts := strings.Split(strings.TrimPrefix(name, schemaPrefix), "_")
		created, err := strconv.ParseInt(parts[0], 10, 64)
		// An unparseable name is from an older layout, and is stale by
		// definition: nothing running now would have made it.
		if err != nil || created < cutoff {
			stale = append(stale, name)
		}
	}
	rows.Close()
	for _, name := range stale {
		if _, err := conn.Exec(ctx, "drop schema "+name+" cascade"); err != nil {
			t.Logf("sweep %s: %v", name, err)
		}
	}
}

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
	sweep.Do(func() { dropStaleSchemas(t, admin) })
	schema := fmt.Sprintf("%s%d_%d_%d", schemaPrefix, time.Now().Unix(), os.Getpid(), counter.Add(1))
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

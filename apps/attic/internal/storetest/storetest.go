// Package storetest gives tests a real ParadeDB, isolated in a throwaway
// schema. Identity decisions and search live in SQL, so a fake store would only
// prove the fake works.
//
// Tests skip only when nothing is listening: the machine that has not started
// the compose stack. A database that answers and refuses fails the test, so a
// wrong DATABASE_URL cannot silently disable every DB-backed test.
package storetest

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/attic/internal/store"
)

var (
	counter atomic.Int64
	sweep   sync.Once
)

// schemaPrefix marks a schema as this package's to drop. The creation time is
// in the name so a later run can sweep what a crashed run left behind.
const schemaPrefix = "attictest_"

const staleAfter = time.Hour

// DSN is the development database, matching the CLI's default.
func DSN() string {
	if dsn := os.Getenv("DATABASE_URL"); dsn != "" {
		return dsn
	}
	return "postgres://attic:attic@localhost:5436/attic?sslmode=disable"
}

// New returns a migrated Store on a schema of its own, dropped when the test
// finishes, and the schema's name for assertions past the Store API.
func New(t *testing.T) (*store.Store, string) {
	t.Helper()
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, DSN())
	if err != nil {
		if unreachable(err) && os.Getenv("ATTIC_REQUIRE_DB") != "1" && os.Getenv("CI") == "" {
			t.Skipf("no database at %s: %v", redacted(DSN()), err)
		}
		t.Fatalf("required database at %s is unavailable: %v", redacted(DSN()), err)
	}
	sweep.Do(func() { dropStale(t, admin) })
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
	u, err := url.Parse(DSN())
	if err != nil {
		t.Fatalf("DATABASE_URL: %v", err)
	}
	q := u.Query()
	// public and paradedb stay on the path: the extension's operators live there.
	q.Set("search_path", schema+",public,paradedb")
	u.RawQuery = q.Encode()
	st, err := store.Open(ctx, u.String())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(st.Close)
	return st, u.String()
}

// QueryInt runs a single-value integer query against the test's schema.
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

func dropStale(t *testing.T, conn *pgx.Conn) {
	ctx := context.Background()
	rows, err := conn.Query(ctx, `select nspname from pg_namespace where nspname like $1`, schemaPrefix+"%")
	if err != nil {
		return
	}
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return
	}
	now := time.Now().Unix()
	for _, name := range names {
		created, err := strconv.ParseInt(strings.Split(strings.TrimPrefix(name, schemaPrefix), "_")[0], 10, 64)
		if err == nil && created >= now-int64(staleAfter.Seconds()) && created <= now {
			continue
		}
		if _, err := conn.Exec(ctx, "drop schema "+name+" cascade"); err != nil {
			t.Logf("sweep %s: %v", name, err)
		}
	}
}

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

// Package storetest gives integration tests a migrated Store on a schema of
// its own inside the database TRACKER_TEST_DATABASE_URL points at. Search,
// claiming and dedup all live in SQL, so a fake store would only prove the
// fake works. Tests skip when the variable is unset.
package storetest

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/uptrace/bun/driver/pgdriver"

	"github.com/aquitano/aqt/apps/tracker/internal/store"
)

const (
	EnvVar       = "TRACKER_TEST_DATABASE_URL"
	schemaPrefix = "trackertest_"
	staleAfter   = time.Hour
)

var (
	counter atomic.Int64
	sweep   sync.Once
)

func New(t *testing.T) *store.Store {
	t.Helper()
	st, _ := NewNamed(t)
	return st
}

// NewNamed also returns the schema name, for assertions on rows the Store
// API does not expose.
func NewNamed(t *testing.T) (*store.Store, string) {
	t.Helper()
	dsn := os.Getenv(EnvVar)
	if dsn == "" {
		t.Skipf("%s not set", EnvVar)
	}
	admin := openSQL(t, dsn)
	sweep.Do(func() { dropStaleSchemas(t, admin) })
	schema := fmt.Sprintf("%s%d_%d_%d", schemaPrefix, time.Now().Unix(), os.Getpid(), counter.Add(1))
	if _, err := admin.Exec("create schema " + schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec("drop schema " + schema + " cascade"); err != nil {
			t.Logf("drop schema %s: %v", schema, err)
		}
	})
	st, err := store.New(context.Background(), sql.OpenDB(searchPathConnector{
		Connector: pgdriver.NewConnector(pgdriver.WithDSN(dsn)), path: searchPath(schema)}))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st, schema
}

// searchPath keeps public and paradedb behind the test schema, because the
// search operators live there.
func searchPath(schema string) string { return schema + ",public,paradedb" }

// searchPathConnector sets the search path on every new connection. pgdriver
// would quote a DSN search_path as one identifier, so a multi-schema path
// cannot travel through the DSN.
type searchPathConnector struct {
	driver.Connector
	path string
}

func (c searchPathConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.Connector.Connect(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := conn.(driver.ExecerContext).ExecContext(ctx, "set search_path to "+c.path, nil); err != nil {
		conn.Close()
		return nil, err
	}
	return conn, nil
}

// QueryInt runs a single-value query inside the schema, for assertions past
// the Store API.
func QueryInt(t *testing.T, schema, query string, args ...any) int64 {
	t.Helper()
	db := openSQL(t, os.Getenv(EnvVar))
	if _, err := db.Exec("set search_path to " + searchPath(schema)); err != nil {
		t.Fatal(err)
	}
	var n int64
	if err := db.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatalf("query: %v\n%s", err, query)
	}
	return n
}

func openSQL(t *testing.T, dsn string) *sql.DB {
	t.Helper()
	db := sql.OpenDB(pgdriver.NewConnector(pgdriver.WithDSN(dsn)))
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		t.Fatalf("%s is set but the database refused: %v", EnvVar, err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// dropStaleSchemas removes schemas a crashed test process never cleaned up.
// The creation time is in the name because a schema has no catalog timestamp.
func dropStaleSchemas(t *testing.T, db *sql.DB) {
	rows, err := db.Query(`select nspname from pg_namespace where nspname like $1`, schemaPrefix+"%")
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
		created, err := strconv.ParseInt(strings.SplitN(strings.TrimPrefix(name, schemaPrefix), "_", 2)[0], 10, 64)
		if err != nil || created < cutoff {
			stale = append(stale, name)
		}
	}
	rows.Close()
	for _, name := range stale {
		if _, err := db.Exec("drop schema " + name + " cascade"); err != nil {
			t.Logf("sweep %s: %v", name, err)
		}
	}
}

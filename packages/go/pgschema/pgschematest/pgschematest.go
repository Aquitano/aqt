// Package pgschematest gives each integration test a database of its own on a
// disposable ParadeDB server. pgtestdb clones it from a template migrated once
// per set of migrations, so a test pays for a copy instead of a migration.
package pgschematest

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"net"
	"net/url"
	"os"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/peterldowns/pgtestdb"
	"github.com/peterldowns/pgtestdb/migrators/common"
)

// Env names the environment variables that point an app's tests at a server.
type Env struct {
	// URL names the variable holding the server's connection URL. Its user
	// creates and owns every test database, as the app's user owns its own.
	URL string
	// Require names the variable that, set to 1, fails tests instead of
	// skipping them, as CI always does.
	Require string
}

// Database returns the URL of a fresh database migrated by m. Tests skip when
// the server is unset or nothing listens there, unless CI or env.Require
// demands it. A server that answers and refuses fails even locally: skipping
// would silently disable every database test while go test stays green.
func Database(t testing.TB, env Env, m pgtestdb.Migrator) string {
	t.Helper()
	required := os.Getenv("CI") != "" || os.Getenv(env.Require) == "1"
	dsn := os.Getenv(env.URL)
	if dsn == "" {
		if required {
			t.Fatalf("%s must name a disposable ParadeDB server", env.URL)
		}
		t.Skipf("%s not set", env.URL)
	}
	u, err := url.Parse(dsn)
	if err != nil || u.Scheme != "postgres" && u.Scheme != "postgresql" {
		t.Fatalf("%s must be a PostgreSQL URL", env.URL)
	}
	conf, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse %s: %v", env.URL, err)
	}
	if err := ping(t.Context(), conf); err != nil {
		if !required && unreachable(err) {
			t.Skipf("no database at %s: %v", u.Redacted(), err)
		}
		t.Fatalf("database at %s is unavailable: %v", u.Redacted(), err)
	}
	return pgtestdb.Custom(t, pgtestdb.Config{
		DriverName: "pgx",
		Host:       conf.Host,
		Port:       strconv.Itoa(int(conf.Port)),
		User:       conf.User,
		Password:   conf.Password,
		Database:   conf.Database,
		Options:    u.RawQuery,
		TestRole:   &pgtestdb.Role{Username: conf.User, Password: conf.Password},
	}, m).URL()
}

func ping(ctx context.Context, conf *pgx.ConnConfig) error {
	conn, err := pgx.ConnectConfig(ctx, conf)
	if err != nil {
		return err
	}
	return conn.Close(ctx)
}

// unreachable reports whether nothing is listening: connection refused or an
// unknown host, the one failure worth a skip.
func unreachable(err error) bool {
	var op *net.OpError
	var dns *net.DNSError
	return errors.As(err, &op) || errors.As(err, &dns)
}

// Migrator builds the template with open, the call the app itself makes at
// startup, and rebuilds it whenever a file in migrations changes.
func Migrator(migrations fs.FS, open func(ctx context.Context, dsn string) error) pgtestdb.Migrator {
	return migrator{migrations: migrations, open: open}
}

type migrator struct {
	migrations fs.FS
	open       func(context.Context, string) error
}

func (m migrator) Hash() (string, error) {
	hash, err := common.HashDirs(m.migrations, "*.sql", ".")
	// The prefix keeps templates that earlier runners built from these same
	// files from being reused.
	return "pgschema-v1-" + hash, err
}

func (m migrator) Migrate(ctx context.Context, _ *sql.DB, conf pgtestdb.Config) error {
	return m.open(ctx, conf.URL())
}

// QueryInt runs a single-value integer query, for assertions on rows an app's
// API does not expose.
func QueryInt(t testing.TB, dsn, query string, args ...any) int64 {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)
	var n int64
	if err := conn.QueryRow(ctx, query, args...).Scan(&n); err != nil {
		t.Fatalf("query: %v\n%s", err, query)
	}
	return n
}

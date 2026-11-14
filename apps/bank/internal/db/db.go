// Package db owns the database schema: the embedded migrations, applying
// them, and opening a pool on a database at the version this binary knows.
package db

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"

	atticstore "github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/packages/go/pgschema"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// Migrations is the schema history Migrate applies, one numbered file per step.
var Migrations, _ = fs.Sub(migrationFiles, "migrations")

// DefaultURL is the database docker-compose.yml publishes, on IPv4 only. With
// "localhost" the driver tries ::1 first, and Windows takes about a second to
// give up on it.
const DefaultURL = "postgres://bank:bank@127.0.0.1:5433/bank?sslmode=disable"

// migrationLock is an arbitrary but fixed advisory-lock key ("bankmig") every
// migrator takes before applying DDL.
const migrationLock int64 = 0x62616e6b6d6967

// A second migrator gives up after this long instead of queueing behind the
// first, whose index builds can take minutes.
const migrationLockTimeout = 10 * time.Second

var (
	ErrBehind = errors.New("run bank migrate to bring it up to date")
	ErrAhead  = errors.New("this binary is older than the database; install a newer build")
)

// Migrate brings the database up to the last embedded migration, then River's
// job tables up to the version this binary's River expects.
func Migrate(ctx context.Context, databaseURL string) error {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return err
	}
	config.MaxConns = 1
	config.ConnConfig.RuntimeParams["lock_timeout"] = migrationLockTimeout.String()
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := pgschema.Migrate(ctx, pool, migrationLock, Migrations); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	if _, err := pool.Exec(ctx, atticstore.RecordTokenizers); err != nil {
		return fmt.Errorf("record search tokenizers: %w", err)
	}
	return migrateRiver(ctx, pool)
}

// migrateRiver runs River's own migrator under the same lock. The pool holds
// one connection, so the session that takes the lock is the one River's
// migrator runs on, and closing the pool releases it.
func migrateRiver(ctx context.Context, pool *pgxpool.Pool) error {
	if _, err := pool.Exec(ctx, `select pg_advisory_lock($1)`, migrationLock); err != nil {
		return err
	}
	migrator, err := riverMigrator(pool)
	if err != nil {
		return err
	}
	if _, err := migrator.Migrate(ctx, rivermigrate.DirectionUp, nil); err != nil {
		return fmt.Errorf("migrate job queue: %w", err)
	}
	_, err = pool.Exec(ctx, `select pg_advisory_unlock($1)`, migrationLock)
	return err
}

func riverMigrator(pool *pgxpool.Pool) (*rivermigrate.Migrator[pgx.Tx], error) {
	return rivermigrate.New(riverpgxv5.New(pool), &rivermigrate.Config{Logger: slog.New(slog.DiscardHandler)})
}

// RiverVersion is the last migration of the River this binary is built with.
func RiverVersion() (int, error) {
	migrator, err := riverMigrator(nil)
	if err != nil {
		return 0, err
	}
	all := migrator.AllVersions()
	return all[len(all)-1].Version, nil
}

// Open connects to a database at exactly the embedded version.
func Open(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	return open(ctx, config)
}

// OpenReadOnly is Open with every session read-only.
func OpenReadOnly(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	config.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	return open(ctx, config)
}

func open(ctx context.Context, config *pgxpool.Config) (*pgxpool.Pool, error) {
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, err
	}
	if err := checkVersion(ctx, pool); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

// checkVersion fails unless the database is at the embedded version and its
// job tables at this binary's River version.
func checkVersion(ctx context.Context, pool *pgxpool.Pool) error {
	current, latest, err := pgschema.Version(ctx, pool, Migrations)
	if err != nil {
		return err
	}
	if err := compareVersions("database schema", int(current), int(latest)); err != nil {
		return err
	}
	migrator, err := riverMigrator(pool)
	if err != nil {
		return err
	}
	applied, err := migrator.ExistingVersions(ctx)
	if err != nil {
		return err
	}
	river := 0
	if len(applied) > 0 {
		river = applied[len(applied)-1].Version
	}
	riverLatest, err := RiverVersion()
	if err != nil {
		return err
	}
	return compareVersions("job queue schema", river, riverLatest)
}

func compareVersions(what string, current, latest int) error {
	switch {
	case current < latest:
		return fmt.Errorf("%s is at version %d, this binary expects %d: %w", what, current, latest, ErrBehind)
	case current > latest:
		return fmt.Errorf("%s is at version %d, this binary knows %d: %w", what, current, latest, ErrAhead)
	}
	return nil
}

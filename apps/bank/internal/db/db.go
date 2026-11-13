// Package db owns the database schema: the embedded migrations, applying
// them, and opening a pool on a database at the version this binary knows.
package db

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

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

// Migrate brings the database up to the last embedded migration.
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
	return nil
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

// checkVersion fails unless the database is at the embedded version.
func checkVersion(ctx context.Context, pool *pgxpool.Pool) error {
	current, latest, err := pgschema.Version(ctx, pool, Migrations)
	switch {
	case err != nil:
		return err
	case current < latest:
		return fmt.Errorf("database schema is at version %d, this binary expects %d: %w", current, latest, ErrBehind)
	case current > latest:
		return fmt.Errorf("database schema is at version %d, this binary knows %d: %w", current, latest, ErrAhead)
	}
	return nil
}

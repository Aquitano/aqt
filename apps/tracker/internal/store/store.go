// Package store owns the Postgres schema and every query. Migrations are
// embedded and applied on Open, so the binary is self-contained.
package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"

	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/pgdialect"
	"github.com/uptrace/bun/driver/pgdriver"
	"github.com/uptrace/bun/migrate"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// migrationLock is an arbitrary fixed advisory-lock key ("trkmig"): two
// processes starting against an unmigrated database serialize on it instead
// of racing the same DDL.
const migrationLock int64 = 0x74726b6d6967

type Store struct {
	db *bun.DB
}

// Open connects and migrates.
func Open(ctx context.Context, dsn string) (*Store, error) {
	return New(ctx, sql.OpenDB(pgdriver.NewConnector(pgdriver.WithDSN(dsn))))
}

// New migrates an already opened database; Open is the usual entry point,
// this one lets tests hand in a connector of their own.
func New(ctx context.Context, sqldb *sql.DB) (*Store, error) {
	db := bun.NewDB(sqldb, pgdialect.New())
	s := &Store{db: db}
	if err := s.migrate(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

func (s *Store) migrate(ctx context.Context) error {
	sub, err := fs.Sub(migrationFS, "migrations")
	if err != nil {
		return err
	}
	migrations := migrate.NewMigrations()
	if err := migrations.Discover(sub); err != nil {
		return err
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `select pg_advisory_lock(?)`, migrationLock); err != nil {
		return err
	}
	defer func() {
		_, _ = conn.ExecContext(context.WithoutCancel(ctx), `select pg_advisory_unlock(?)`, migrationLock)
	}()
	m := migrate.NewMigrator(s.db, migrations)
	if err := m.Init(ctx); err != nil {
		return err
	}
	_, err = m.Migrate(ctx)
	return err
}

type URLKey struct {
	Hash       []byte
	Normalized string
	Host       string
}

func upsertURL(ctx context.Context, db bun.IDB, u URLKey) (int64, error) {
	var id int64
	err := db.NewRaw(`insert into urls (url_hash, normalized_url, host) values (?, ?, ?)
		on conflict (url_hash) do update set host = excluded.host
		returning id`, u.Hash, u.Normalized, u.Host).Scan(ctx, &id)
	return id, err
}

var ErrNotFound = errors.New("not found")

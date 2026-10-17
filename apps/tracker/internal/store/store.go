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
	"time"

	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/pgdialect"
	"github.com/uptrace/bun/driver/pgdriver"
	"github.com/uptrace/bun/migrate"

	"github.com/aquitano/aqt/packages/go/pgschema/paradedb"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// Migrations is the schema history Open applies, one numbered file per step.
var Migrations, _ = fs.Sub(migrationFiles, "migrations")

// migrationLock is an arbitrary fixed advisory-lock key ("trkmig"): two
// processes starting against an unmigrated database serialize on it instead
// of racing the same DDL.
const migrationLock int64 = 0x74726b6d6967

type Store struct {
	db *bun.DB
}

// Open connects and migrates. A statement runs until its context's deadline:
// pgdriver's default socket timeouts would cut a long migration, reprocess or
// forget off at 10 s. A DSN's read_timeout and write_timeout still apply.
func Open(ctx context.Context, dsn string) (*Store, error) {
	db := bun.NewDB(sql.OpenDB(pgdriver.NewConnector(
		pgdriver.WithReadTimeout(0), pgdriver.WithWriteTimeout(0), pgdriver.WithDSN(dsn))), pgdialect.New())
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
	migrations := migrate.NewMigrations()
	if err := migrations.Discover(Migrations); err != nil {
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
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		_, _ = conn.ExecContext(cleanupCtx, `select pg_advisory_unlock(?)`, migrationLock)
	}()
	if _, err := conn.ExecContext(ctx, paradedb.UpdatePgSearch); err != nil {
		return err
	}
	m := migrate.NewMigrator(s.db, migrations, migrate.WithMarkAppliedOnSuccess(true))
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

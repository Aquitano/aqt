// Package pgschema applies an app's embedded SQL migrations with tern, after
// the ParadeDB upgrade step.
package pgschema

import (
	"context"
	"io/fs"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/tern/v2/migrate"

	"github.com/aquitano/aqt/packages/go/pgschema/paradedb"
)

const versionTable = "public.schema_version"

// Migrate brings the database up to the last file in migrations. Callers
// serialize on lockKey.
func Migrate(ctx context.Context, pool *pgxpool.Pool, lockKey int64, migrations fs.FS) error {
	pooled, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	// Closing releases both advisory locks even if cancellation stopped tern
	// from unlocking after a failed migration, so this session is never reused.
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = pooled.Hijack().Close(cleanup)
	}()
	conn := pooled.Conn()
	if _, err := conn.Exec(ctx, `select pg_advisory_lock($1)`, lockKey); err != nil {
		return err
	}
	if _, err := conn.Exec(ctx, paradedb.UpdatePgSearch); err != nil {
		return err
	}
	m, err := migrate.NewMigrator(ctx, conn, versionTable)
	if err != nil {
		return err
	}
	if err := m.LoadMigrations(migrations); err != nil {
		return err
	}
	return m.Migrate(ctx)
}

// Version reports the version Migrate recorded and the latest one migrations
// define, without changing the database. A database Migrate never ran on
// reports version zero.
func Version(ctx context.Context, pool *pgxpool.Pool, migrations fs.FS) (current, latest int32, err error) {
	names, err := migrate.FindMigrations(migrations)
	if err != nil {
		return 0, 0, err
	}
	var initialized bool
	if err := pool.QueryRow(ctx, `select to_regclass($1) is not null`, versionTable).Scan(&initialized); err != nil {
		return 0, 0, err
	}
	if initialized {
		if err := pool.QueryRow(ctx, `select version from `+versionTable).Scan(&current); err != nil {
			return 0, 0, err
		}
	}
	return current, int32(len(names)), nil
}

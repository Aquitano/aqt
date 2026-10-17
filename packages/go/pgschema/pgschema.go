// Package pgschema applies an app's embedded SQL migrations with tern, after
// the ParadeDB upgrade step and after adopting the history of the runner the
// apps used before tern.
package pgschema

import (
	"context"
	"fmt"
	"io/fs"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/tern/v2/migrate"

	"github.com/aquitano/aqt/packages/go/pgschema/paradedb"
)

// Migrate brings the database up to the last file in migrations. Callers
// serialize on lockKey, which must stay the key the legacy runner took, so an
// older binary cannot migrate while a database adopts its history.
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
	m, err := adoptLegacyHistory(ctx, conn, migrations)
	if err != nil {
		return err
	}
	return m.Migrate(ctx)
}

// adoptLegacyHistory creates tern's version table and, on a database the
// legacy runner migrated, sets it to the number of files that runner applied.
// Both commit together: a crash must never leave version zero beside an
// already migrated schema.
func adoptLegacyHistory(ctx context.Context, conn *pgx.Conn, migrations fs.FS) (*migrate.Migrator, error) {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	var initialized, legacy bool
	if err := tx.QueryRow(ctx, `select to_regclass('public.schema_version') is not null,
		to_regclass('public.schema_migrations') is not null`).Scan(&initialized, &legacy); err != nil {
		return nil, err
	}
	m, err := migrate.NewMigrator(ctx, conn, "public.schema_version")
	if err != nil {
		return nil, err
	}
	if err := m.LoadMigrations(migrations); err != nil {
		return nil, err
	}
	if !initialized && legacy {
		rows, err := tx.Query(ctx, `select filename from public.schema_migrations order by filename`)
		if err != nil {
			return nil, err
		}
		applied, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return nil, err
		}
		for i, name := range applied {
			if i >= len(m.Migrations) || name != m.Migrations[i].Name {
				return nil, fmt.Errorf("legacy migration history is not a contiguous known prefix at %q; restore a consistent schema before upgrading", name)
			}
		}
		if err := m.SetVersion(ctx, int32(len(applied))); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return m, nil
}

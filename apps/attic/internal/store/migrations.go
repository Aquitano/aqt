package store

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/tern/v2/migrate"
)

// Migrations holds the schema as SQL files under migrations/.
//
//go:embed migrations/*.sql
var Migrations embed.FS

// Keep the legacy lock so an older command cannot migrate concurrently.
const migrationLock int64 = 0x61747469636d6967

// A new ParadeDB image only replaces the pg_search binary, and its SQL functions
// fail until the catalog is updated to match.
const updatePgSearch = `do $$ begin
  if exists (select from pg_extension e join pg_available_extensions a on a.name = e.extname
    where e.extname = 'pg_search' and e.extversion <> a.default_version) then
    alter extension pg_search update;
  end if;
end $$`

func (s *Store) migrate(ctx context.Context) error {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		// Both tern and the legacy runner use session locks. Closing releases
		// them even if a cancelled migration could not execute its unlock.
		_ = conn.Conn().Close(cleanup)
		conn.Release()
	}()
	if _, err := conn.Exec(ctx, `select pg_advisory_lock($1)`, migrationLock); err != nil {
		return err
	}
	if _, err := conn.Exec(ctx, updatePgSearch); err != nil {
		return err
	}
	files, err := fs.Sub(Migrations, "migrations")
	if err != nil {
		return err
	}
	m, err := migrationBaseline(ctx, conn.Conn(), files)
	if err != nil {
		return err
	}
	return m.Migrate(ctx)
}

// Create the version table and adopt legacy history in one transaction. A
// crash must never leave version zero beside an already migrated catalogue.
func migrationBaseline(ctx context.Context, conn *pgx.Conn, files fs.FS) (*migrate.Migrator, error) {
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
	if err := m.LoadMigrations(files); err != nil {
		return nil, err
	}
	if !initialized && legacy {
		rows, err := tx.Query(ctx, `select filename from public.schema_migrations order by filename`)
		if err != nil {
			return nil, err
		}
		names, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return nil, err
		}
		for i, name := range names {
			if i >= len(m.Migrations) || name != m.Migrations[i].Name {
				return nil, fmt.Errorf("legacy migration history is not a contiguous known prefix at %q", name)
			}
		}
		if err := m.SetVersion(ctx, int32(len(names))); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return m, nil
}

package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/tern/v2/migrate"
)

// Keep the old lock during the transition so an older process cannot race the
// one-off baseline. Tern owns migration transactions and its version table.
func (s *Store) migrate(ctx context.Context) error {
	pooled, err := s.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	// Closing also releases either advisory lock if cancellation prevented Tern
	// from unlocking after a failed migration. Never recycle this session.
	defer func() { _ = pooled.Hijack().Close(context.WithoutCancel(ctx)) }()
	conn := pooled.Conn()
	if _, err = conn.Exec(ctx, `select pg_advisory_lock($1)`, migrationLock); err != nil {
		return err
	}
	if err := baselineLegacy(ctx, conn); err != nil {
		return err
	}
	m, err := migrate.NewMigrator(ctx, conn, "public.schema_version")
	if err != nil {
		return err
	}
	if err = m.LoadMigrations(Migrations); err != nil {
		return err
	}
	return m.Migrate(ctx)
}

func baselineLegacy(ctx context.Context, conn *pgx.Conn) error {
	var versionExists, legacyExists bool
	if err := conn.QueryRow(ctx, `select to_regclass('public.schema_version') is not null,
 to_regclass('public.schema_migrations') is not null`).Scan(&versionExists, &legacyExists); err != nil {
		return err
	}
	if versionExists || !legacyExists {
		return nil
	}
	names, err := migrate.FindMigrations(Migrations)
	if err != nil {
		return err
	}
	rows, err := conn.Query(ctx, `select filename from public.schema_migrations order by filename`)
	if err != nil {
		return err
	}
	applied, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	for i, name := range applied {
		if i >= len(names) || name != names[i] {
			return fmt.Errorf("legacy migration history is not a contiguous known prefix at %q; restore a consistent schema before upgrading", name)
		}
	}
	// Creation and baseline commit together. A crash cannot leave version zero
	// beside an already populated legacy schema.
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	m, err := migrate.NewMigrator(ctx, conn, "public.schema_version")
	if err != nil {
		return err
	}
	if err = m.SetVersion(ctx, int32(len(applied))); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

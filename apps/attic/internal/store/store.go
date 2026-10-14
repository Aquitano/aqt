// Package store owns attic's Postgres schema and every query. Migrations are
// embedded and applied on Open, so the binary is self-contained.
package store

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrations embed.FS

// migrationLock is a fixed advisory-lock key ("atticmig"), so two commands
// starting against an unmigrated database cannot both run the same DDL.
const migrationLock int64 = 0x61747469636d6967

// A new ParadeDB image only replaces the pg_search binary, and its SQL functions
// fail until the catalog is updated to match.
const updatePgSearch = `do $$ begin
  if exists (select from pg_extension e join pg_available_extensions a on a.name = e.extname
    where e.extname = 'pg_search' and e.extversion <> a.default_version) then
    alter extension pg_search update;
  end if;
end $$`

// ErrNotFound is returned when a lookup found no row.
var ErrNotFound = errors.New("not found")

type Store struct {
	pool *pgxpool.Pool
}

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	s := &Store{pool: pool}
	if err := s.migrate(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return s, nil
}

func (s *Store) Close() { s.pool.Close() }

// migrate applies pending migrations under a session-level advisory lock. Each
// runs in a transaction and is recorded only when its DDL committed.
func (s *Store) migrate(ctx context.Context) error {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `select pg_advisory_lock($1)`, migrationLock); err != nil {
		return err
	}
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `select pg_advisory_unlock($1)`, migrationLock)
	}()

	if _, err := conn.Exec(ctx, updatePgSearch); err != nil {
		return err
	}
	if _, err := conn.Exec(ctx,
		`create table if not exists schema_migrations (filename text primary key, applied_at timestamptz not null default now())`); err != nil {
		return err
	}
	files, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(files))
	for _, f := range files {
		names = append(names, f.Name())
	}
	sort.Strings(names)
	for _, name := range names {
		var applied bool
		if err := conn.QueryRow(ctx,
			`select exists (select 1 from schema_migrations where filename = $1)`, name).Scan(&applied); err != nil {
			return err
		}
		if applied {
			continue
		}
		sql, err := migrations.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		tx, err := conn.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("%s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, `insert into schema_migrations (filename) values ($1)`, name); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("%s: %w", name, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	return nil
}

// cleanText makes a string safe for a Postgres text column. File names on old
// disks are not always valid UTF-16, and Postgres rejects NUL bytes.
func cleanText(s string) string {
	if utf8.ValidString(s) && !strings.ContainsRune(s, 0) {
		return s
	}
	return strings.ReplaceAll(strings.ToValidUTF8(s, "�"), "\x00", "")
}

// nullTime stores a zero time as NULL: the file system did not report it.
func nullTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}

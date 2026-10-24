// Package store owns attic's Postgres schema and every query. Migrations are
// embedded and applied on Open, so the binary is self-contained; OpenReadOnly
// only checks that the catalogue is at the embedded version.
package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aquitano/aqt/packages/go/pgschema"
)

// ErrNotFound is returned when a lookup found no row.
var ErrNotFound = errors.New("not found")

var (
	ErrCatalogueNotMigrated = errors.New("run attic migrate (or a scan) to bring it up to date")
	ErrBinaryOutdated       = errors.New("this attic binary is older than the catalogue; install a newer build")
)

type Store struct {
	pool *pgxpool.Pool
}

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if err := pgschema.Migrate(ctx, pool, migrationLock, Migrations); err != nil {
		pool.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	if _, err := pool.Exec(ctx, recordTokenizers); err != nil {
		pool.Close()
		return nil, fmt.Errorf("record search tokenizers: %w", err)
	}
	return &Store{pool: pool}, nil
}

// OpenReadOnly connects without migrating or updating extensions, so reads never
// wait on or take the migration lock. Every session is read-only.
func OpenReadOnly(ctx context.Context, databaseURL string) (*Store, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	config.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, err
	}
	st := &Store{pool: pool}
	if err := st.checkSchema(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return st, nil
}

func (s *Store) checkSchema(ctx context.Context) error {
	current, latest, err := s.SchemaVersion(ctx)
	switch {
	case err != nil:
		return err
	case current == 0:
		return fmt.Errorf("catalogue has no schema: %w", ErrCatalogueNotMigrated)
	case current < latest:
		return fmt.Errorf("catalogue schema is at version %d, this attic expects %d: %w", current, latest, ErrCatalogueNotMigrated)
	case current > latest:
		return fmt.Errorf("catalogue schema is at version %d, this attic knows %d: %w", current, latest, ErrBinaryOutdated)
	}
	return nil
}

func (s *Store) SchemaVersion(ctx context.Context) (current, latest int32, err error) {
	return pgschema.Version(ctx, s.pool, Migrations)
}

func (s *Store) Close() { s.pool.Close() }

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

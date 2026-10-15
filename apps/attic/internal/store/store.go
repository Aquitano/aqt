// Package store owns attic's Postgres schema and every query. Migrations are
// embedded and applied on Open, so the binary is self-contained.
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
	return &Store{pool: pool}, nil
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

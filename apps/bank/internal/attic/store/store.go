// Package store holds every query on the catalogue's tables. The schema is
// package db's.
package store

import (
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned when a lookup found no row.
var ErrNotFound = errors.New("not found")

type Store struct {
	pool *pgxpool.Pool
}

// New queries through pool, which stays its opener's to close.
func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// CleanText makes a string safe for a Postgres text column. File names on old
// disks are not always valid UTF-16, and Postgres rejects NUL bytes.
func CleanText(s string) string {
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

package store

import (
	"context"
	"database/sql/driver"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Query limits. The timeout is a literal in the SET LOCAL below because
// Postgres does not take parameters there.
const (
	queryDefaultRows = 100
	queryMaxRows     = 10000
	queryTimeout     = "15s"
)

// QueryResult is what one ad-hoc SQL query returned. Rows are positional
// (matching Columns) rather than maps, so duplicate column names and column
// order survive the trip through JSON.
type QueryResult struct {
	Columns []string `json:"columns"`
	Rows    [][]any  `json:"rows"`
	// Truncated is set when the row cap cut the result short; the query
	// itself may have matched more.
	Truncated bool `json:"truncated"`
}

// BadQueryError marks a failure caused by the caller's SQL or options, so the
// server can answer 400 instead of 500.
type BadQueryError struct{ Err error }

func (e *BadQueryError) Error() string { return e.Err.Error() }
func (e *BadQueryError) Unwrap() error { return e.Err }

// Query runs one ad-hoc SQL statement and returns up to limit rows (0 means
// the default cap). It is the OLAP escape hatch behind `bank query`, held
// read-only three ways: the transaction is READ ONLY so any write or DDL
// fails at the executor, a statement_timeout bounds runaway scans, and the
// extended query protocol rejects a second ';'-chained statement outright.
func (s *Store) Query(ctx context.Context, query string, limit int) (QueryResult, error) {
	if limit == 0 {
		limit = queryDefaultRows
	}
	if limit < 1 || limit > queryMaxRows {
		return QueryResult{}, &BadQueryError{fmt.Errorf("limit must be 1-%d, got %d", queryMaxRows, limit)}
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return QueryResult{}, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err := tx.Exec(ctx, `set local statement_timeout = '`+queryTimeout+`'`); err != nil {
		return QueryResult{}, err
	}
	rows, err := tx.Query(ctx, query)
	if err != nil {
		return QueryResult{}, classifyQueryErr(err)
	}
	defer rows.Close()

	res := QueryResult{Columns: []string{}, Rows: [][]any{}}
	for _, fd := range rows.FieldDescriptions() {
		res.Columns = append(res.Columns, fd.Name)
	}
	for rows.Next() {
		if len(res.Rows) == limit {
			res.Truncated = true
			break
		}
		vals, err := rows.Values()
		if err != nil {
			return QueryResult{}, err
		}
		row := make([]any, len(vals))
		for i, v := range vals {
			row[i] = normalizeValue(v)
		}
		res.Rows = append(res.Rows, row)
	}
	// rows.Err also reports a mid-stream statement_timeout, which is the
	// query's fault, not the server's.
	if err := rows.Err(); err != nil && !res.Truncated {
		return QueryResult{}, classifyQueryErr(err)
	}
	return res, nil
}

func classifyQueryErr(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return &BadQueryError{err}
	}
	return err
}

// normalizeValue flattens pgx's decoded values into something every JSON
// encoder and printer downstream can handle: pgtype wrappers become their
// driver value, bytea becomes text or base64, and anything still exotic
// falls back to its string form rather than an encoding error.
func normalizeValue(v any) any {
	switch x := v.(type) {
	case nil, bool, int16, int32, int64, float32, float64, string, time.Time:
		return x
	case []byte:
		if utf8.Valid(x) {
			return string(x)
		}
		return base64.StdEncoding.EncodeToString(x)
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = normalizeValue(e)
		}
		return out
	}
	// driver.Value is documented to be a primitive (or nil), so this
	// recursion terminates in the switch above.
	if val, ok := v.(driver.Valuer); ok {
		if dv, err := val.Value(); err == nil {
			return normalizeValue(dv)
		}
	}
	if b, err := json.Marshal(v); err == nil {
		return json.RawMessage(b)
	}
	return fmt.Sprint(v)
}

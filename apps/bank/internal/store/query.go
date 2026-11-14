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
	queryTimeout     = 15 * time.Second
	// QueryMaxValue is the most of one value a result carries.
	QueryMaxValue = 64 << 10
	// QueryMaxResult bounds the values of a whole result, so a cap of
	// 10000 rows cannot mean 10000 large documents.
	QueryMaxResult = 8 << 20
	// queryBatch is how many rows one FETCH asks for, which bounds what a
	// result cut short at the size cap has read past it.
	queryBatch = 100
)

// QueryResult is what one ad-hoc SQL query returned. Rows are positional
// (matching Columns) rather than maps, so duplicate column names and column
// order survive the trip through JSON.
type QueryResult struct {
	Columns []string `json:"columns"`
	Rows    [][]any  `json:"rows" doc:"Each row is an array in the order of columns."`
	// Truncated is set when the result stops before the query's last row.
	Truncated bool `json:"truncated" doc:"The result stops before the query's last row: at the row cap, or at 8 MiB of values."`
	// CutValues counts values cut to QueryMaxValue.
	CutValues int `json:"cut_values" doc:"Values longer than 64 KiB, cut to their first 64 KiB. A cut value that was not text is a cut string of its JSON."`
}

// BadQueryError marks a failure caused by the caller's SQL or options, so the
// server can answer 400 instead of 500.
type BadQueryError struct{ Err error }

func (e *BadQueryError) Error() string { return e.Err.Error() }
func (e *BadQueryError) Unwrap() error { return e.Err }

// Query runs one ad-hoc SQL query and returns up to limit rows (0 means the
// default cap). It is the OLAP escape hatch behind `bank query`, held on a
// separately authenticated, restricted connection. A READ ONLY transaction,
// statement timeout, row and size caps and a cursor add resource limits: the
// query is declared as a cursor, which accepts only a query and is parsed as
// one statement, and rows are fetched in batches until a cap is reached, so
// the server stops reading there.
func (s *Store) Query(ctx context.Context, query string, limit int) (QueryResult, error) {
	if limit == 0 {
		limit = queryDefaultRows
	}
	if limit < 1 || limit > queryMaxRows {
		return QueryResult{}, &BadQueryError{fmt.Errorf("limit must be 1-%d, got %d", queryMaxRows, limit)}
	}
	if s.queryPool == nil {
		return QueryResult{}, fmt.Errorf("ad-hoc queries require BANK_QUERY_DATABASE_URL with a restricted login role")
	}
	ctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()
	tx, err := s.queryPool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return QueryResult{}, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err := tx.Exec(ctx, `set local statement_timeout = '`+queryTimeout.String()+`'`); err != nil {
		return QueryResult{}, err
	}
	// ExecParams uses the extended protocol, which refuses a second statement.
	if _, err := tx.Conn().PgConn().ExecParams(ctx, "declare bank_query no scroll cursor for "+query, nil, nil, nil, nil).Close(); err != nil {
		return QueryResult{}, classifyQueryErr(err)
	}
	res := QueryResult{Columns: []string{}, Rows: [][]any{}}
	size := 0
	for done := false; !done; {
		want := min(queryBatch, limit+1-len(res.Rows))
		fetched, err := fetchQueryRows(ctx, tx, want, limit, &res, &size)
		if err != nil {
			return QueryResult{}, err
		}
		done = res.Truncated || fetched < want
	}
	return res, nil
}

// fetchQueryRows reads up to want rows of the cursor into res, and stops
// early at the row cap or the size cap.
func fetchQueryRows(ctx context.Context, tx pgx.Tx, want, limit int, res *QueryResult, size *int) (int, error) {
	// The statement is fixed text, so the simple protocol is safe here, and
	// unlike a prepared FETCH it describes the cursor's columns.
	rows, err := tx.Query(ctx, fmt.Sprintf("fetch forward %d from bank_query", want), pgx.QueryExecModeSimpleProtocol)
	if err != nil {
		return 0, classifyQueryErr(err)
	}
	defer rows.Close()
	if len(res.Columns) == 0 {
		for _, fd := range rows.FieldDescriptions() {
			res.Columns = append(res.Columns, fd.Name)
		}
	}
	fetched := 0
	for rows.Next() {
		fetched++
		if len(res.Rows) == limit {
			res.Truncated = true
			return fetched, nil
		}
		vals, err := rows.Values()
		if err != nil {
			return fetched, err
		}
		row := make([]any, len(vals))
		for i, v := range vals {
			value, n, cut := capValue(normalizeValue(v))
			row[i], *size = value, *size+n
			if cut {
				res.CutValues++
			}
		}
		if *size > QueryMaxResult {
			res.Truncated = true
			return fetched, nil
		}
		res.Rows = append(res.Rows, row)
	}
	// rows.Err also reports a mid-stream statement_timeout, which is the
	// query's fault, not the server's.
	return fetched, classifyQueryErr(rows.Err())
}

// capValue cuts v to QueryMaxValue bytes and reports its size and whether it
// was cut.
func capValue(v any) (any, int, bool) {
	s, isText := v.(string)
	if !isText {
		encoded, err := json.Marshal(v)
		if err != nil || len(encoded) <= QueryMaxValue {
			return v, len(encoded), false
		}
		s = string(encoded)
	}
	if len(s) <= QueryMaxValue {
		return v, len(s), false
	}
	s = s[:QueryMaxValue]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s, len(s), true
}

func classifyQueryErr(err error) error {
	if err == nil {
		return nil
	}
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

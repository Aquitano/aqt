package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestQueryIsReadOnly(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)

	if _, err := st.InsertMessage(ctx, msg("gmail", "q1", store.Message{Sender: "a@example.com", Body: "hello"})); err != nil {
		t.Fatal(err)
	}

	var bad *store.BadQueryError
	for _, sql := range []string{
		"insert into messages (source, sender, body, sent_at) values ('x', 'a', 'b', now())",
		"update messages set body = 'gone'",
		"delete from messages",
		"drop table messages",
		"create table sneaky (id int)",
	} {
		_, err := st.Query(ctx, sql, 10)
		if !errors.As(err, &bad) {
			t.Fatalf("%q: err = %v, want BadQueryError from the read-only transaction", sql, err)
		}
	}

	// The write attempts must not have aborted anything that sticks: the
	// archive still answers, and still holds exactly the row we put in.
	res, err := st.Query(ctx, "select count(*) from messages", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Rows) != 1 || res.Rows[0][0] != int64(1) {
		t.Fatalf("count after write attempts: %+v", res.Rows)
	}
}

func TestQueryTruncatesAtLimit(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)

	res, err := st.Query(ctx, "select generate_series(1, 50)", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Rows) != 10 || !res.Truncated {
		t.Fatalf("got %d rows, truncated=%v; want 10 rows, truncated", len(res.Rows), res.Truncated)
	}

	res, err = st.Query(ctx, "select generate_series(1, 5)", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Rows) != 5 || res.Truncated {
		t.Fatalf("got %d rows, truncated=%v; want 5 rows, not truncated", len(res.Rows), res.Truncated)
	}

	var bad *store.BadQueryError
	if _, err := st.Query(ctx, "select 1", 100001); !errors.As(err, &bad) {
		t.Fatalf("oversized limit: err = %v, want BadQueryError", err)
	}
}

// The cursor stops the work at the cap: every row past it would sleep, so a
// query that read on to the end would run into the statement timeout.
func TestQueryStopsReadingAtItsCaps(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)

	started := time.Now()
	res, err := st.Query(ctx, "select g, pg_sleep(0.01) from generate_series(1, 5000) g", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Rows) != 10 || !res.Truncated || time.Since(started) > 5*time.Second {
		t.Fatalf("got %d rows, truncated=%v after %s; want 10 rows, truncated, at once", len(res.Rows), res.Truncated, time.Since(started))
	}

	res, err = st.Query(ctx, "select repeat('x', 70000) as long, 'short' as short", 10)
	if err != nil {
		t.Fatal(err)
	}
	if long, _ := res.Rows[0][0].(string); len(long) != store.QueryMaxValue || res.CutValues != 1 || res.Truncated {
		t.Fatalf("a long value: %d bytes, %d cut, truncated=%v", len(long), res.CutValues, res.Truncated)
	}

	res, err = st.Query(ctx, "select repeat('x', 60000) from generate_series(1, 1000)", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Truncated || len(res.Rows)*60000 > store.QueryMaxResult {
		t.Fatalf("a large result: %d rows, truncated=%v", len(res.Rows), res.Truncated)
	}

	var bad *store.BadQueryError
	if _, err := st.Query(ctx, "select 1; select 2", 10); !errors.As(err, &bad) {
		t.Fatalf("two statements: err = %v, want BadQueryError", err)
	}
}

func TestQueryErrorsAndShapes(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)

	var bad *store.BadQueryError
	if _, err := st.Query(ctx, "select * from no_such_table", 10); !errors.As(err, &bad) {
		t.Fatalf("bad relation: err = %v, want BadQueryError", err)
	}
	if _, err := st.Query(ctx, "select 1; select 2", 10); !errors.As(err, &bad) {
		t.Fatalf("multi-statement: err = %v, want BadQueryError", err)
	}

	res, err := st.Query(ctx, "select 'a' as s, 2::numeric as n, null as missing", 10)
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Columns; len(got) != 3 || got[0] != "s" || got[1] != "n" || got[2] != "missing" {
		t.Fatalf("columns: %v", got)
	}
	row := res.Rows[0]
	if row[0] != "a" || row[2] != nil {
		t.Fatalf("row values: %+v", row)
	}
}

func TestQueryLoginCannotEscapeReadOnly(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	result, err := st.Query(ctx, "select current_user, session_user", 1)
	if err != nil {
		t.Fatal(err)
	}
	if result.Rows[0][0] != "bank_query_test" || result.Rows[0][1] != "bank_query_test" {
		t.Fatalf("query uses privileged authentication: %v", result.Rows)
	}
	conn, err := pgx.Connect(ctx, storetest.QueryDSN(t, dsn))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	// Even outside a READ ONLY transaction the login itself has no escape.
	for _, sql := range []string{
		`copy (select 1) to program 'true'`,
		`select pg_read_file('/etc/passwd')`,
		`select count(*) from pg_catalog.pg_authid`,
		`select pg_ls_dir('/')`,
		`set role bank`,
		`set session authorization bank`,
		`update messages set body = 'lost'`,
		`create table public.sneaky (id int)`,
	} {
		if _, err := conn.Exec(ctx, sql); err == nil {
			t.Errorf("restricted login executed %q", sql)
		}
		if _, err := st.Query(ctx, sql, 1); err == nil {
			t.Errorf("ad-hoc query executed %q", sql)
		}
	}
	if _, err := st.Query(ctx, `select count(*) from messages`, 1); err != nil {
		t.Fatal(err)
	}
}

func TestQueryConfigurationRejectsPrivilegedConnections(t *testing.T) {
	ctx := context.Background()
	dsn := storetest.Migrated(t)
	st := store.New(storetest.Pool(t, dsn))
	if _, err := st.Query(ctx, "select 1", 1); err == nil {
		t.Fatal("missing query connection fell back to writer")
	}
	if err := st.ConfigureQuery(ctx, dsn); err == nil {
		t.Fatal("accepted ingestion credentials")
	}
	// A non-superuser with a write grant is also invalid, even if the connection
	// defaults to read-only. The grant belongs only to this disposable database.
	storetest.Exec(t, dsn, `grant update on messages to bank_query_test`)
	if err := st.ConfigureQuery(ctx, storetest.QueryDSN(t, dsn)); err == nil {
		t.Fatal("accepted a query login with write privileges")
	}
	storetest.Exec(t, dsn, `revoke update on messages from bank_query_test; grant execute on function pg_read_file(text) to bank_query_test`)
	if err := st.ConfigureQuery(ctx, storetest.QueryDSN(t, dsn)); err == nil {
		t.Fatal("accepted a direct server-file function grant")
	}
}

package pgschema_test

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"testing/fstest"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/peterldowns/pgtestdb"

	"github.com/aquitano/aqt/packages/go/pgschema"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

const lockKey int64 = 0x7067736368656d61

var files = fstest.MapFS{
	"001_items.sql": {Data: []byte(`create table items (id int primary key, label text not null)`)},
	"002_notes.sql": {Data: []byte(`alter table items add column note text`)},
	"003_tags.sql":  {Data: []byte(`create table tags (name text primary key)`)},
}

// legacyDatabase applies the first prefix files the way the legacy runner did,
// recording each in schema_migrations.
func legacyDatabase(t *testing.T, prefix int) string {
	t.Helper()
	dsn := pgschematest.Database(t, "PGSCHEMA_TEST_DATABASE_URL", pgtestdb.NoopMigrator{})
	exec(t, dsn, `create table schema_migrations (filename text primary key, applied_at timestamptz not null default now())`)
	names := []string{"001_items.sql", "002_notes.sql", "003_tags.sql"}
	for _, name := range names[:prefix] {
		exec(t, dsn, string(files[name].Data))
		exec(t, dsn, `insert into schema_migrations (filename) values ($1)`, name)
	}
	if prefix > 0 {
		exec(t, dsn, `insert into items (id, label) values (1, 'keep me')`)
	}
	return dsn
}

func migrate(ctx context.Context, dsn string) error {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return err
	}
	defer pool.Close()
	return pgschema.Migrate(ctx, pool, lockKey, files)
}

func exec(t *testing.T, dsn, sql string, args ...any) {
	t.Helper()
	pool, err := pgxpool.New(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(t.Context(), sql, args...); err != nil {
		t.Fatalf("%v\n%s", err, sql)
	}
}

func TestMigrateAdoptsLegacyHistory(t *testing.T) {
	for _, prefix := range []int{0, 1, 3} {
		t.Run(fmt.Sprint(prefix), func(t *testing.T) {
			dsn := legacyDatabase(t, prefix)
			// Parallel startup must neither replay DDL nor skip pending files.
			var wg sync.WaitGroup
			for range 3 {
				wg.Go(func() {
					if err := migrate(t.Context(), dsn); err != nil {
						t.Error(err)
					}
				})
			}
			wg.Wait()
			if v := pgschematest.QueryInt(t, dsn, `select version from schema_version`); v != int64(len(files)) {
				t.Fatalf("version = %d, want %d", v, len(files))
			}
			if n := pgschematest.QueryInt(t, dsn, `select count(*) from schema_migrations`); n != int64(prefix) {
				t.Fatalf("legacy history changed: %d rows, want %d", n, prefix)
			}
			if prefix > 0 {
				if n := pgschematest.QueryInt(t, dsn, `select count(*) from items where label = 'keep me'`); n != 1 {
					t.Fatal("the legacy row is gone")
				}
			}
		})
	}
}

func TestMigrateRejectsInvalidLegacyHistoryWithoutBaseline(t *testing.T) {
	for _, filename := range []string{"003_tags.sql", "004_unknown.sql"} {
		t.Run(filename, func(t *testing.T) {
			dsn := legacyDatabase(t, 1)
			exec(t, dsn, `insert into schema_migrations (filename) values ($1)`, filename)
			err := migrate(t.Context(), dsn)
			if err == nil || !strings.Contains(err.Error(), "contiguous known prefix") {
				t.Fatalf("err = %v, want a rejected history", err)
			}
			if n := pgschematest.QueryInt(t, dsn, `select count(*) from pg_tables where schemaname = 'public' and tablename = 'schema_version'`); n != 0 {
				t.Fatal("invalid legacy history was marked as baselined")
			}
		})
	}
}

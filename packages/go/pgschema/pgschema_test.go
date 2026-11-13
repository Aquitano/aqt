package pgschema_test

import (
	"context"
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

func emptyDatabase(t *testing.T) string {
	t.Helper()
	return pgschematest.Database(t, "PGSCHEMA_TEST_DATABASE_URL", pgtestdb.NoopMigrator{})
}

func migrate(ctx context.Context, dsn string) error {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return err
	}
	defer pool.Close()
	return pgschema.Migrate(ctx, pool, lockKey, files)
}

func TestParallelMigratesApplyEachFileOnce(t *testing.T) {
	dsn := emptyDatabase(t)
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
}

func TestVersionReadsWithoutMigrating(t *testing.T) {
	dsn := emptyDatabase(t)
	pool, err := pgxpool.New(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if current, latest, err := pgschema.Version(t.Context(), pool, files); err != nil || current != 0 || latest != 3 {
		t.Fatalf("empty: %d, %d, %v", current, latest, err)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from pg_tables where schemaname = 'public' and tablename = 'schema_version'`); n != 0 {
		t.Fatal("Version created the version table")
	}
	if err := pgschema.Migrate(t.Context(), pool, lockKey, files); err != nil {
		t.Fatal(err)
	}
	if current, latest, err := pgschema.Version(t.Context(), pool, files); err != nil || current != 3 || latest != 3 {
		t.Fatalf("migrated: %d, %d, %v", current, latest, err)
	}
}

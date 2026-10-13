package store_test

import (
	"context"
	"fmt"
	"io/fs"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/peterldowns/pgtestdb"

	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/apps/attic/internal/storetest"
)

func legacyDatabase(t *testing.T, prefix int) (*pgx.Conn, string, []fs.DirEntry) {
	t.Helper()
	conf := pgtestdb.Custom(t, storetest.Config(t), pgtestdb.NoopMigrator{})
	conn, err := pgx.Connect(t.Context(), conf.URL())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	files, err := store.Migrations.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(t.Context(), `create table schema_migrations (filename text primary key, applied_at timestamptz not null default now())`); err != nil {
		t.Fatal(err)
	}
	for _, file := range files[:prefix] {
		sql, err := store.Migrations.ReadFile("migrations/" + file.Name())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Exec(t.Context(), string(sql)); err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Exec(t.Context(), `insert into schema_migrations (filename) values ($1)`, file.Name()); err != nil {
			t.Fatal(err)
		}
	}
	if prefix > 0 {
		if _, err := conn.Exec(t.Context(), `insert into volumes (label, fs_type, serial, stable_ids) values ('keep me', 'test', 'legacy', false)`); err != nil {
			t.Fatal(err)
		}
	}
	return conn, conf.URL(), files
}

func TestMigrationAdoptsLegacyHistory(t *testing.T) {
	for _, prefix := range []int{0, 1, 6, 7} {
		t.Run(fmt.Sprint(prefix), func(t *testing.T) {
			conn, dsn, files := legacyDatabase(t, prefix)
			// Parallel startup must neither replay DDL nor skip pending files.
			var wg sync.WaitGroup
			for range 3 {
				wg.Go(func() {
					st, err := store.Open(t.Context(), dsn)
					if err != nil {
						t.Error(err)
						return
					}
					st.Close()
				})
			}
			wg.Wait()
			var version, history int
			if err := conn.QueryRow(t.Context(), `select version from schema_version`).Scan(&version); err != nil {
				t.Fatal(err)
			}
			if version != len(files) {
				t.Fatalf("version = %d, want %d", version, len(files))
			}
			if err := conn.QueryRow(t.Context(), `select count(*) from schema_migrations`).Scan(&history); err != nil {
				t.Fatal(err)
			}
			if history != prefix {
				t.Fatalf("legacy history changed: %d", history)
			}
			if prefix > 0 {
				var label string
				if err := conn.QueryRow(t.Context(), `select label from volumes where serial='legacy'`).Scan(&label); err != nil || label != "keep me" {
					t.Fatalf("legacy row = %q, %v", label, err)
				}
			}
		})
	}
}

func TestMigrationRejectsInvalidLegacyHistoryWithoutBaseline(t *testing.T) {
	for _, filename := range []string{"0003_texts.sql", "0008_unknown.sql"} {
		t.Run(filename, func(t *testing.T) {
			conn, dsn, _ := legacyDatabase(t, 1)
			if _, err := conn.Exec(t.Context(), `insert into schema_migrations (filename) values ($1)`, filename); err != nil {
				t.Fatal(err)
			}
			st, err := store.Open(t.Context(), dsn)
			if err == nil {
				st.Close()
				t.Fatal("accepted invalid history")
			}
			if !strings.Contains(err.Error(), "contiguous known prefix") {
				t.Fatal(err)
			}
			var exists bool
			if err := conn.QueryRow(t.Context(), `select to_regclass('public.schema_version') is not null`).Scan(&exists); err != nil {
				t.Fatal(err)
			}
			if exists {
				t.Fatal("failed adoption left a version table")
			}
		})
	}
}

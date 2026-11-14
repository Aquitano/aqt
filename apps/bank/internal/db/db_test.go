package db_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/db"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

func TestOpenRefusesADatabaseAtAnotherVersion(t *testing.T) {
	empty := storetest.NewEmpty(t)
	if _, err := db.Open(t.Context(), empty); !errors.Is(err, db.ErrBehind) {
		t.Fatalf("empty database: %v", err)
	}
	if n := pgschematest.QueryInt(t, empty, `select count(*) from pg_tables where schemaname = 'public' and tablename in ('schema_version', 'messages', 'entries')`); n != 0 {
		t.Fatal("opening created the schema")
	}
	for _, tc := range []struct {
		shift string
		want  error
	}{{"version - 1", db.ErrBehind}, {"version + 1", db.ErrAhead}} {
		dsn := storetest.Migrated(t)
		pgschematest.QueryInt(t, dsn, `with u as (update schema_version set version = `+tc.shift+` returning version) select version from u`)
		if _, err := db.OpenReadOnly(t.Context(), dsn); !errors.Is(err, tc.want) {
			t.Fatalf("%s: %v, want %v", tc.shift, err, tc.want)
		}
	}
	dsn := storetest.Migrated(t)
	storetest.Exec(t, dsn, `delete from river_migration where version = (select max(version) from river_migration)`)
	if _, err := db.Open(t.Context(), dsn); !errors.Is(err, db.ErrBehind) {
		t.Fatalf("job queue a migration behind: %v", err)
	}
}

func TestConcurrentMigrationsSerialize(t *testing.T) {
	dsn := storetest.NewEmpty(t)
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			if err := db.Migrate(context.Background(), dsn); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	pool, err := db.Open(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	pool.Close()
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from schema_version`); n != 1 {
		t.Errorf("%d version rows, want 1", n)
	}
}

func TestFailedMigrationLeavesARetryableState(t *testing.T) {
	dsn := storetest.NewEmpty(t)
	// A relation already sitting on a name the migration creates makes it fail.
	storetest.Exec(t, dsn, `create table messages_thread_idx ()`)
	if err := db.Migrate(context.Background(), dsn); err == nil {
		t.Fatal("a broken migration should surface, not be swallowed")
	}
	// The lock is released, so a retry gets as far as the same clear failure
	// instead of hanging.
	done := make(chan error, 1)
	go func() { done <- db.Migrate(context.Background(), dsn) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("the second attempt unexpectedly succeeded")
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the migration lock was not released after a failure")
	}
}

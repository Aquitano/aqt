package store_test

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/apps/attic/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

func TestOpenReadOnlyReadsButCannotWrite(t *testing.T) {
	_, dsn := storetest.New(t)
	st, err := store.OpenReadOnly(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if _, err := st.KnownVolumes(t.Context()); err != nil {
		t.Fatal(err)
	}
	_, err = st.ResolveVolume(t.Context(), disk.Volume{Label: "Data"}, "", true)
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); !ok || pgErr.Code != "25006" {
		t.Fatalf("write on a read-only store: %v", err)
	}
}

func TestOpenReadOnlyRejectsOtherSchemaVersions(t *testing.T) {
	for _, tc := range []struct {
		name  string
		shift string
		want  error
	}{
		{"older", "version - 1", store.ErrCatalogueNotMigrated},
		{"newer", "version + 1", store.ErrBinaryOutdated},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, dsn := storetest.New(t)
			pgschematest.QueryInt(t, dsn, `with u as (update schema_version set version = `+tc.shift+` returning version) select version from u`)
			if _, err := store.OpenReadOnly(t.Context(), dsn); !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestOpenReadOnlyLeavesEmptyDatabaseUntouched(t *testing.T) {
	dsn := storetest.Empty(t)
	if _, err := store.OpenReadOnly(t.Context(), dsn); !errors.Is(err, store.ErrCatalogueNotMigrated) {
		t.Fatalf("err = %v", err)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from pg_tables where schemaname = 'public' and tablename in ('schema_version', 'volumes')`); n != 0 {
		t.Fatal("OpenReadOnly created the schema")
	}
}

package store_test

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aquitano/aqt/apps/bank/internal/attic/disk"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/attic/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema"
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
	if _, err := st.Search(t.Context(), store.SearchOptions{Query: "report", Limit: 5}); err != nil {
		t.Fatalf("name search on a read-only store: %v", err)
	}
	if _, err := st.SearchTexts(t.Context(), store.SearchOptions{Query: "report", Limit: 5}); err != nil {
		t.Fatalf("text search on a read-only store: %v", err)
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
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from pg_tables where schemaname in ('public', 'attic') and tablename in ('schema_version', 'volumes')`); n != 0 {
		t.Fatal("OpenReadOnly created the schema")
	}
}

func TestOpenMovesStandaloneCatalogueIntoItsSchema(t *testing.T) {
	dsn := storetest.Empty(t)
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	// While attic had a database to itself, it migrated into public.
	if err := pgschema.Migrate(ctx, pool, 12345, store.Migrations); err != nil {
		t.Fatal(err)
	}
	const volume = "00000000-0000-0000-0000-000000000001"
	if _, err := pool.Exec(ctx, `
  insert into volumes(id,label,fs_type,serial,stable_ids) values ('`+volume+`','Archive','TEST','1',true);
  insert into scans(id,volume_id,root,status) overriding system value values (1,'`+volume+`','','complete');
  insert into entries(id,volume_id,parent_id,kind,name,raw_name,path,size_bytes,content_id,hash_state,missing_scan,first_scan,updated_scan) overriding system value values
   (1,'`+volume+`',null,'dir','',''::bytea,'',0,null,'none',null,1,1),
   (2,'`+volume+`',1,'file','minecraft-server.zip','minecraft-server.zip'::bytea,'/minecraft-server.zip',5,null,'pending',null,1,1)`); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from pg_tables where schemaname = 'public' and tablename in ('schema_version', 'volumes', 'entries')`); n != 0 {
		t.Fatalf("%d catalogue tables stayed in public", n)
	}
	// The BM25 index moved with its table and still answers.
	hits, err := st.Search(ctx, store.SearchOptions{Query: "minecraft", Limit: 5})
	if err != nil || len(hits) != 1 {
		t.Fatalf("name search after the move: %d hits, %v", len(hits), err)
	}
}

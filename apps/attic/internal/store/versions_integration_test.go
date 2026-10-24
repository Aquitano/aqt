package store_test

import (
	"context"
	"io/fs"
	"testing"
	"testing/fstest"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/packages/go/pgschema"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

func TestVersionMigrationGivesHashedEntriesTheirCurrentVersion(t *testing.T) {
	previous := fstest.MapFS{}
	names, err := fs.Glob(store.Migrations, "*.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if name >= "0010" {
			continue
		}
		data, err := fs.ReadFile(store.Migrations, name)
		if err != nil {
			t.Fatal(err)
		}
		previous[name] = &fstest.MapFile{Data: data}
	}
	migrator := pgschematest.Migrator(previous, func(ctx context.Context, dsn string) error {
		pool, err := pgxpool.New(ctx, dsn)
		if err != nil {
			return err
		}
		defer pool.Close()
		return pgschema.Migrate(ctx, pool, 12345, previous)
	})
	dsn := pgschematest.Database(t, "ATTIC_TEST_DATABASE_URL", migrator)
	ctx := t.Context()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, `
  insert into volumes(id,fs_type,serial,stable_ids) values ('00000000-0000-0000-0000-000000000001','TEST','1',true);
  insert into scans(id,volume_id,root,status) overriding system value values
   (1,'00000000-0000-0000-0000-000000000001','','complete'), (2,'00000000-0000-0000-0000-000000000001','','complete');
  insert into contents(id,blake3,size_bytes) overriding system value values (1,decode(repeat('11',32),'hex'),5);
  insert into entries(id,volume_id,parent_id,kind,name,raw_name,path,size_bytes,content_id,hash_state,missing_scan,first_scan,updated_scan) overriding system value values
   (1,'00000000-0000-0000-0000-000000000001',null,'dir','',''::bytea,'',0,null,'none',null,1,1),
   (2,'00000000-0000-0000-0000-000000000001',1,'file','hashed','hashed'::bytea,'/hashed',5,1,'done',null,1,2),
   (3,'00000000-0000-0000-0000-000000000001',1,'file','copy','copy'::bytea,'/copy',5,1,'done',2,1,1),
   (4,'00000000-0000-0000-0000-000000000001',1,'file','pending','pending'::bytea,'/pending',7,null,'pending',null,1,1)`)
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	if n := pgschematest.QueryInt(t, dsn, `select count(*) from entry_versions`); n != 2 {
		t.Fatalf("backfilled %d versions, want one for each hashed entry, missing ones included", n)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from entry_versions v join entries e on e.id = v.entry_id
		where v.content_id = e.content_id and v.size_bytes = e.size_bytes and v.first_scan = e.updated_scan and v.replaced_scan is null`); n != 2 {
		t.Errorf("%d of two versions are open with the entry's content, size and last scan", n)
	}
}

package store_test

import (
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/apps/attic/internal/storetest"
)

func TestDedupePlanPairsKeptAndExtraCopies(t *testing.T) {
	st, dsn := storetest.New(t)
	ctx := t.Context()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	const volume = "00000000-0000-0000-0000-000000000001"
	// Content 1 has a kept and an extra copy; 2 only extra copies; 3 only kept
	// copies; 4 an extra copy the last scan no longer found.
	if _, err := conn.Exec(ctx, `
  insert into volumes(id,label,fs_type,serial,stable_ids) values ('`+volume+`','Data','TEST','1',true);
  insert into scans(id,volume_id,root,status) overriding system value values (1,'`+volume+`','','complete'), (2,'`+volume+`','','complete');
  insert into contents(id,blake3,size_bytes) overriding system value values
   (1,decode(repeat('01',32),'hex'),2000000), (2,decode(repeat('02',32),'hex'),2000000),
   (3,decode(repeat('03',32),'hex'),2000000), (4,decode(repeat('04',32),'hex'),2000000);
  insert into entries(id,volume_id,parent_id,kind,name,raw_name,path,size_bytes,content_id,hash_state,missing_scan,first_scan,updated_scan) overriding system value values
   (1,'`+volume+`',null,'dir','',''::bytea,'',0,null,'none',null,1,1),
   (2,'`+volume+`',1,'file','a2','a2'::bytea,'/Files/a',2000000,1,'done',null,1,1),
   (3,'`+volume+`',1,'file','a3','a3'::bytea,'/Backup/a',2000000,1,'done',null,1,1),
   (4,'`+volume+`',1,'file','b4','b4'::bytea,'/Backup/b',2000000,2,'done',null,1,1),
   (5,'`+volume+`',1,'file','b5','b5'::bytea,'/Backup/old/b',2000000,2,'done',null,1,1),
   (6,'`+volume+`',1,'file','c6','c6'::bytea,'/Files/c',2000000,3,'done',null,1,1),
   (7,'`+volume+`',1,'file','c7','c7'::bytea,'/Files/sub/c',2000000,3,'done',null,1,1),
   (8,'`+volume+`',1,'file','d8','d8'::bytea,'/Files/d',2000000,4,'done',null,1,1),
   (9,'`+volume+`',1,'file','d9','d9'::bytea,'/Backup/d',2000000,4,'done',2,1,1),
   (10,'`+volume+`',1,'file','a10','a10'::bytea,'/Filesystem/a',2000000,1,'done',null,1,1)`); err != nil {
		t.Fatal(err)
	}
	kept := []store.KeptFolder{{VolumeID: volume, Path: "/Files"}}

	groups, err := st.DedupePlan(ctx, kept, 1<<20, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 1 || groups[0].ContentID != 1 || len(groups[0].Kept) != 1 || groups[0].Kept[0].ID != 2 {
		t.Fatalf("groups = %+v, want content 1 kept at /Files/a", groups)
	}
	extra := groups[0].Extra
	if len(extra) != 2 || extra[0].Path != "/Backup/a" || extra[1].Path != "/Filesystem/a" {
		t.Fatalf("extra copies = %+v; /Filesystem is not inside /Files", extra)
	}

	if err := st.RecordDedupeMove(ctx, store.DedupeMove{EntryID: 3, KeptEntryID: 2, ContentID: 1, MovedTo: `E:\.attic-quarantine\run\Backup\a`}); err != nil {
		t.Fatal(err)
	}
	if groups, err = st.DedupePlan(ctx, kept, 1<<20, 10); err != nil || len(groups) != 1 || len(groups[0].Extra) != 1 {
		t.Fatalf("after the move: %+v %v; the moved copy must leave the plan", groups, err)
	}
	d, err := st.Entry(ctx, 3)
	if err != nil {
		t.Fatal(err)
	}
	if d.SetAside == nil || d.SetAside.KeptEntryID != 2 || d.SetAside.MovedTo != `E:\.attic-quarantine\run\Backup\a` {
		t.Fatalf("entry 3 set aside = %+v", d.SetAside)
	}

	// A complete listing after the move that still finds the copy, as when it
	// was put back by hand, returns it to the plan.
	if _, err := conn.Exec(ctx, `
  insert into scans(id,volume_id,root,status,started_at) overriding system value
   select 3,'`+volume+`'::uuid,'','complete',moved_at + interval '1 second' from dedupe_moves where entry_id = 3;
  update entries set listed_scan = 3 where id = 1`); err != nil {
		t.Fatal(err)
	}
	if groups, err = st.DedupePlan(ctx, kept, 1<<20, 10); err != nil || len(groups) != 1 || len(groups[0].Extra) != 2 {
		t.Fatalf("after the copy came back: %+v %v", groups, err)
	}
}

package store_test

import (
	"context"
	"errors"
	"io/fs"
	"slices"
	"testing"
	"testing/fstest"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/apps/attic/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

func TestMissingDeviceSerialRequiresExplicitResolution(t *testing.T) {
	st, _ := storetest.New(t)
	ctx := t.Context()
	mounted := disk.Volume{Fingerprint: disk.Fingerprint{FS: "TEST", Serial: "same", DeviceSerial: "hardware"}}
	known, err := st.ResolveVolume(ctx, mounted, "", false)
	if err != nil {
		t.Fatal(err)
	}
	mounted.DeviceSerial = ""
	var ambiguous *store.AmbiguousVolumeError
	if _, err := st.ResolveVolume(ctx, mounted, "", false); !errors.As(err, &ambiguous) {
		t.Fatalf("missing serial: %v", err)
	}
	if selected, err := st.ResolveVolume(ctx, mounted, known.ID, false); err != nil || selected.ID != known.ID {
		t.Fatalf("explicit volume: %+v, %v", selected, err)
	}
	if fresh, err := st.ResolveVolume(ctx, mounted, "", true); err != nil || fresh.ID == known.ID {
		t.Fatalf("explicit new volume: %+v, %v", fresh, err)
	}
}

func TestIdentityMigrationBackfillsAndRepairsDescendants(t *testing.T) {
	previous := fstest.MapFS{}
	names, err := fs.Glob(store.Migrations, "*.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if name >= "0008" {
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
  insert into scans(id,volume_id,root,status) overriding system value values (1,'00000000-0000-0000-0000-000000000001','','complete');
  insert into entries(id,volume_id,parent_id,kind,name,path,file_id,hash_state,first_scan,updated_scan) overriding system value values
   (1,'00000000-0000-0000-0000-000000000001',null,'dir','','',1,'none',1,1),
   (2,'00000000-0000-0000-0000-000000000001',1,'file','replaced','/replaced',2,'pending',1,1),
   (3,'00000000-0000-0000-0000-000000000001',2,'dir','nested','/replaced/nested',3,'none',1,1),
   (4,'00000000-0000-0000-0000-000000000001',3,'file','child','/replaced/nested/child',4,'pending',1,1),
   (5,'00000000-0000-0000-0000-000000000001',1,'dir','moved','/moved',5,'none',1,1),
   (6,'00000000-0000-0000-0000-000000000001',5,'file','valid','/moved/valid',6,'pending',1,1)`)
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if n := pgschematest.QueryInt(t, dsn, "select count(*) from entries where missing_scan is not null"); n != 2 {
		t.Fatalf("marked %d rows missing, want the two descendants", n)
	}
	if n := pgschematest.QueryInt(t, dsn, "select count(*) from entries where raw_name=convert_to(name,'UTF8') and physical_file_id=file_id"); n != 6 {
		t.Fatalf("backfilled %d of six rows", n)
	}
	if n := pgschematest.QueryInt(t, dsn, "select count(*) from entries where id in (1,2,5,6) and missing_scan is null"); n != 4 {
		t.Fatalf("retained %d of four valid rows", n)
	}
}

func TestHardLinkReuseRejectsUnverifiedIdentityAndMetadata(t *testing.T) {
	st, dsn := storetest.New(t)
	ctx := t.Context()
	mounted := disk.Volume{Fingerprint: disk.Fingerprint{FS: "TEST", Serial: "source", DeviceSerial: "hardware", StableIDs: true}}
	volume, err := st.ResolveVolume(ctx, mounted, "", false)
	if err != nil {
		t.Fatal(err)
	}
	mounted.Serial = "other"
	other, err := st.ResolveVolume(ctx, mounted, "", false)
	if err != nil {
		t.Fatal(err)
	}
	sc, err := st.StartScan(ctx, volume, "")
	if err != nil {
		t.Fatal(err)
	}
	defer sc.Finish(ctx, "complete", nil)
	dirs, err := sc.ApplyListing(ctx, nil, []store.Listed{{Kind: "dir", FileID: 1}}, nil, false, func(string, int64) bool { return true })
	if err != nil {
		t.Fatal(err)
	}
	modified := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	changed := modified.Add(time.Hour)
	files := []store.Listed{
		{Name: "a.bin", Kind: "file", FileID: 42, Size: 4, Modified: modified, Changed: changed, HashState: "pending"},
		{Name: "b.bin", Kind: "file", FileID: 42, Size: 4, Modified: modified, Changed: changed, HashState: "pending"},
	}
	if _, err := sc.ApplyListing(ctx, &dirs[0], files, nil, true, func(string, int64) bool { return true }); err != nil {
		t.Fatal(err)
	}
	if err := sc.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	pending, err := sc.NextPending(ctx, store.Pending{}, 10)
	if err != nil || len(pending) != 2 {
		t.Fatalf("pending %+v, %v", pending, err)
	}
	if err := sc.SetContent(ctx, pending[0], [32]byte{1}); err != nil {
		t.Fatal(err)
	}
	if err := sc.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	observed := disk.Entry{FileID: 42, Size: 4, Modified: modified, Changed: changed}
	cases := []struct {
		name   string
		change func(*disk.Entry)
	}{
		{"different file", func(e *disk.Entry) { e.FileID++ }},
		{"different size", func(e *disk.Entry) { e.Size++ }},
		{"different modified time", func(e *disk.Entry) { e.Modified = e.Modified.Add(time.Second) }},
		{"different change time", func(e *disk.Entry) { e.Changed = e.Changed.Add(time.Second) }},
		{"unknown change time", func(e *disk.Entry) { e.Changed = time.Time{} }},
		{"symlink", func(e *disk.Entry) { e.Link = true }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			seen := observed
			tc.change(&seen)
			if reused, err := sc.ReuseContent(ctx, pending[1], seen); err != nil || reused {
				t.Fatalf("reused=%v, %v", reused, err)
			}
		})
	}
	sc.Volume.StableIDs = false
	if reused, err := sc.ReuseContent(ctx, pending[1], observed); err != nil || reused {
		t.Fatalf("unstable volume reused=%v, %v", reused, err)
	}
	sc.Volume.StableIDs = true
	pgschematest.QueryInt(t, dsn, "update entries set volume_id=$2 where id=$1 returning id", pending[0].ID, other.ID)
	if reused, err := sc.ReuseContent(ctx, pending[1], observed); err != nil || reused {
		t.Fatalf("different volume reused=%v, %v", reused, err)
	}
	pgschematest.QueryInt(t, dsn, "update entries set volume_id=$2 where id=$1 returning id", pending[0].ID, volume.ID)
	if reused, err := sc.ReuseContent(ctx, pending[1], observed); err != nil || !reused {
		t.Fatalf("verified hardlink reused=%v, %v", reused, err)
	}
}

func TestHardLinkOwnerIsObservedOncePerScan(t *testing.T) {
	st, dsn := storetest.New(t)
	ctx := t.Context()
	volume, err := st.ResolveVolume(ctx, disk.Volume{Fingerprint: disk.Fingerprint{
		FS: "TEST", Serial: "links", StableIDs: true,
	}}, "", false)
	if err != nil {
		t.Fatal(err)
	}
	sc, err := st.StartScan(ctx, volume, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if sc != nil {
			_ = sc.Finish(ctx, "interrupted", nil)
		}
	})
	apply := func(parent *store.Dir, listed []store.Listed, holds func(string, int64) bool) []store.Dir {
		t.Helper()
		dirs, err := sc.ApplyListing(ctx, parent, slices.Clone(listed), nil, true, holds)
		if err != nil {
			t.Fatal(err)
		}
		return dirs
	}
	root := apply(nil, []store.Listed{{Kind: "dir", FileID: 1}}, nil)
	dirs := apply(&root[0], []store.Listed{
		{Name: "owner", Kind: "dir", FileID: 2},
		{Name: "links", Kind: "dir", FileID: 3},
	}, nil)
	links := apply(&dirs[1], []store.Listed{
		{Name: "a", Kind: "dir", FileID: 4},
		{Name: "b", Kind: "dir", FileID: 5},
	}, nil)
	file := []store.Listed{{Name: "linked.bin", Kind: "file", FileID: 42, HashState: "pending"}}
	for phase := range 3 {
		probes := 0
		holds := func(path string, id int64) bool {
			if path != "/owner/linked.bin" || id != 42 {
				t.Fatalf("unexpected owner observation: %s, %d", path, id)
			}
			probes++
			return phase < 2
		}
		if phase == 0 {
			apply(&dirs[0], file, holds)
		} else {
			sc, err = st.StartScan(ctx, volume, "/links")
			if err != nil {
				t.Fatal(err)
			}
		}
		for _, link := range links {
			apply(&link, file, holds)
		}
		if err := sc.Finish(ctx, "complete", nil); err != nil {
			t.Fatal(err)
		}
		sc = nil
		if probes != 1 {
			t.Fatalf("phase %d: observed owner %d times, want one", phase, probes)
		}
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from entries
		where path='/owner/linked.bin' and missing_scan is not null`); n != 1 {
		t.Fatal("partial scan did not vacate the disappeared owner")
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from entries
		where kind='file' and missing_scan is null`); n != 2 {
		t.Fatalf("kept %d links, want two", n)
	}
}

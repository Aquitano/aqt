package store_test

import (
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/disks/disk"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

func TestMissingDeviceSerialRequiresExplicitResolution(t *testing.T) {
	st, _ := storetest.NewNamed(t)
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

func TestHardLinkReuseRejectsUnverifiedIdentityAndMetadata(t *testing.T) {
	st, dsn := storetest.NewNamed(t)
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
	pgschematest.QueryInt(t, dsn, "update entries set hash_trusted=false where id=$1 returning id", pending[0].ID)
	if reused, err := sc.ReuseContent(ctx, pending[1], observed); err != nil || reused {
		t.Fatalf("legacy hardlink reused=%v, %v", reused, err)
	}
	pgschematest.QueryInt(t, dsn, "update entries set hash_trusted=true where id=$1 returning id", pending[0].ID)
	if reused, err := sc.ReuseContent(ctx, pending[1], observed); err != nil || !reused {
		t.Fatalf("verified hardlink reused=%v, %v", reused, err)
	}
	if err := sc.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if n := pgschematest.QueryInt(t, dsn, "select count(*) from entries where hash_trusted"); n != 2 {
		t.Fatalf("trusted hardlink copies: %d", n)
	}
}

func TestHardLinkOwnerIsObservedOncePerScan(t *testing.T) {
	st, dsn := storetest.NewNamed(t)
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

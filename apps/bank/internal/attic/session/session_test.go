package session

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/attic/disk"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

// started opens a scan of a whole volume and returns its manager, the scan,
// the volume and the database.
func started(t *testing.T) (*Manager, StartedScan, store.Volume, string) {
	t.Helper()
	st, dsn := storetest.NewCatalogue(t)
	m := New(st, t.TempDir())
	t.Cleanup(func() { _ = m.Close() })
	v, err := m.Resolve(t.Context(), VolumeRequest{Mounted: MountedVolume{Root: `E:\`,
		Fingerprint: disk.Fingerprint{FS: "NTFS", Serial: "7E57", Label: "Data", DeviceSerial: "device", StableIDs: true}}})
	if err != nil {
		t.Fatal(err)
	}
	s, err := m.Start(t.Context(), ScanStart{VolumeID: v.ID})
	if err != nil {
		t.Fatal(err)
	}
	return m, s, v, dsn
}

func TestBatchSentTwiceIsAppliedOnce(t *testing.T) {
	m, s, _, dsn := started(t)
	file := func(name string, id int64) ListedEntry {
		return ListedEntry{Name: []byte(name), Kind: "file", FileID: id, Size: 4, Modified: time.Unix(1700000000, 0), HashState: "pending"}
	}
	b := Batch{Seq: 1, Ops: []Op{
		{Listing: &FolderListing{Entries: []ListedEntry{{Name: []byte(""), Kind: "dir", Folder: 1, FileID: 1, HashState: "pending"}}}},
		{Listing: &FolderListing{Folder: 1, Complete: true, Entries: []ListedEntry{file("a.txt", 2), file("b.txt", 3)}}},
		{Skip: &ScanSkip{Path: "/node_modules", Reason: "excluded"}},
	}}
	first, err := m.Apply(t.Context(), s.ScanID, b)
	if err != nil {
		t.Fatal(err)
	}
	again, err := m.Apply(t.Context(), s.ScanID, b)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(again, first) || first.Counts.Listed != 3 || first.Counts.Written != 3 || first.Counts.Skipped != 1 {
		t.Fatalf("first %+v, again %+v", first, again)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from entries`); n != 3 {
		t.Errorf("%d entries, want the root and two files", n)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from skips`); n != 1 {
		t.Errorf("%d skips, want one", n)
	}
	if _, err := m.Apply(t.Context(), s.ScanID, Batch{Seq: 3}); err == nil {
		t.Error("a batch after a missing one was applied")
	}
	done, err := m.Apply(t.Context(), s.ScanID, Batch{Seq: 2, Finish: &FinishRequest{Status: "complete"}})
	if err != nil || !done.Finished || done.Counts != first.Counts || done.Pending != 2 {
		t.Fatalf("finish: %+v, %v", done, err)
	}
	if replayed, err := m.Apply(t.Context(), s.ScanID, Batch{Seq: 2, Finish: &FinishRequest{Status: "complete"}}); err != nil || !reflect.DeepEqual(replayed, done) {
		t.Errorf("finish sent again: %+v, %v", replayed, err)
	}
}

func TestIdleScanIsInterruptedAndReleasesItsVolume(t *testing.T) {
	m, s, v, dsn := started(t)
	if _, err := m.Start(t.Context(), ScanStart{VolumeID: v.ID}); !errors.Is(err, store.ErrScanRunning) {
		t.Fatalf("second scan of an open volume: %v", err)
	}
	m.expire(time.Now().Add(m.idle - time.Second))
	if err := m.Touch(s.ScanID); err != nil {
		t.Fatalf("a scan expired before its idle time: %v", err)
	}
	m.expire(time.Now().Add(m.idle + time.Second))
	if _, err := m.Apply(t.Context(), s.ScanID, Batch{Seq: 1}); !errors.Is(err, ErrNotOpen) {
		t.Fatalf("batch for an expired scan: %v", err)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from scans where id = $1 and status = 'interrupted' and finished_at is not null`, s.ScanID); n != 1 {
		t.Fatal("the expired scan is not recorded as interrupted")
	}
	next, err := m.Start(t.Context(), ScanStart{VolumeID: v.ID})
	if err != nil {
		t.Fatalf("the volume stayed locked: %v", err)
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from scans where id = $1 and status = 'interrupted'`, next.ScanID); n != 1 {
		t.Fatal("closing the manager left its scan open")
	}
}

func TestQuietScanIsReplacedAndALiveOneRefused(t *testing.T) {
	m, s, v, dsn := started(t)
	open, err := m.session(s.ScanID)
	if err != nil {
		t.Fatal(err)
	}
	quietFor := func(d time.Duration) { open.seen.Store(time.Now().Add(-d).UnixNano()) }
	quietFor(2*m.keepAlive - time.Second)
	if _, err := m.Start(t.Context(), ScanStart{VolumeID: v.ID}); !errors.Is(err, store.ErrScanRunning) {
		t.Fatalf("a scan still sending keepalives was replaced: %v", err)
	}
	quietFor(2*m.keepAlive + time.Second)
	next, err := m.Start(t.Context(), ScanStart{VolumeID: v.ID})
	if err != nil {
		t.Fatalf("a quiet scan kept its volume: %v", err)
	}
	if _, err := m.Apply(t.Context(), s.ScanID, Batch{Seq: 1}); !errors.Is(err, ErrNotOpen) {
		t.Fatalf("batch for the replaced scan: %v", err)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from scans where id = $1 and status = 'interrupted' and finished_at is not null`, s.ScanID); n != 1 {
		t.Fatal("the replaced scan is not recorded as interrupted")
	}
	if err := m.Touch(next.ScanID); err != nil {
		t.Fatalf("the new scan is not open: %v", err)
	}
}

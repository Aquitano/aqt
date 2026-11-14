package scan

import (
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/attic/disk"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

func at(root string) Options {
	return Options{Path: root, locate: func(string) (disk.Volume, []string, error) {
		return disk.Volume{Fingerprint: testVolume, Root: root}, nil, nil
	}}
}

func TestReadTokenCannotScan(t *testing.T) {
	st, dsn := storetest.NewCatalogue(t)
	s := serve(t, st)
	root := t.TempDir()
	write(t, root, "a.txt", "a")
	_, err := Run(t.Context(), Remote(client.New(s.url, s.read)), at(root))
	if e, ok := errors.AsType[*client.Error](err); !ok || e.Status != http.StatusForbidden {
		t.Fatalf("scan with a read token: %v", err)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from volumes`); n != 0 {
		t.Errorf("a read token recorded %d volumes", n)
	}
}

func TestSecondScanOfAnOpenVolumeIsRefused(t *testing.T) {
	st, _ := storetest.NewCatalogue(t)
	s := serve(t, st)
	root := t.TempDir()
	write(t, root, "a.txt", "a")
	v, err := s.scan.ResolveVolume(t.Context(), disk.Volume{Fingerprint: testVolume, Root: root}, "", false)
	if err != nil {
		t.Fatal(err)
	}
	open, err := s.scan.StartScan(t.Context(), v, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Run(t.Context(), s.scan, at(root)); !errors.Is(err, store.ErrScanRunning) {
		t.Fatalf("second scan: %v", err)
	}
	if _, err := open.Finish(t.Context(), "interrupted", store.PhaseTimes{}, nil); err != nil {
		t.Fatal(err)
	}
	scanAt(t, st, root, testVolume)
}

// A batch carries thousands of entries, and a rescan that finds nothing new
// reads no pages beyond the first, so its requests stay the same as the tree
// grows.
func TestUnchangedRescanRequestsDoNotGrowWithFiles(t *testing.T) {
	requests := func(files int) (first, rescan int64) {
		st, _ := storetest.NewCatalogue(t)
		s := serve(t, st)
		root := t.TempDir()
		for i := range files {
			write(t, root, fmt.Sprintf("folder-%d/file-%04d.bin", i%10, i), fmt.Sprint(i))
		}
		before := s.requests.Load()
		scanAt(t, st, root, testVolume)
		first = s.requests.Load() - before
		before = s.requests.Load()
		scanAt(t, st, root, testVolume)
		return first, s.requests.Load() - before
	}
	smallFirst, small := requests(100)
	largeFirst, large := requests(3000)
	t.Logf("first scan: %d requests for 100 files, %d for 3000; unchanged rescan: %d and %d", smallFirst, largeFirst, small, large)
	if large != small {
		t.Errorf("an unchanged rescan of 3000 files made %d requests, of 100 files %d", large, small)
	}
}

package scan

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/disks/disk"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

func at(root string) Options {
	return Options{Path: root, locate: func(string) (disk.Volume, []string, error) {
		return disk.Volume{Fingerprint: testVolume, Root: root}, nil, nil
	}}
}

func TestReadTokenCannotScan(t *testing.T) {
	st, dsn := storetest.NewNamed(t)
	s := serve(t, st)
	root := t.TempDir()
	write(t, root, "a.txt", "a")
	_, err := Run(t.Context(), Remote(client.New(s.url, s.read), func(Wait) {}), at(root))
	if e, ok := errors.AsType[*client.Error](err); !ok || e.Status != http.StatusForbidden {
		t.Fatalf("scan with a read token: %v", err)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from volumes`); n != 0 {
		t.Errorf("a read token recorded %d volumes", n)
	}
}

func TestSecondScanOfAnOpenVolumeIsRefused(t *testing.T) {
	st, _ := storetest.NewNamed(t)
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
		st, _ := storetest.NewNamed(t)
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

// outageClock waits by moving its time forward, and ends the outage once the
// time passes until.
type outageClock struct {
	mu     sync.Mutex
	now    time.Time
	until  time.Time
	down   *atomic.Bool
	pauses []time.Duration
}

func (c *outageClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *outageClock) After(d time.Duration) <-chan time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	c.pauses = append(c.pauses, d)
	if !c.now.Before(c.until) {
		c.down.Store(false)
	}
	done := make(chan time.Time, 1)
	done <- c.now
	return done
}

// goesDown takes the server down once the scan has started.
type goesDown struct {
	Catalogue
	down *atomic.Bool
}

func (g goesDown) StartScan(ctx context.Context, v store.Volume, root string) (Session, error) {
	sc, err := g.Catalogue.StartScan(ctx, v, root)
	g.down.Store(true)
	return sc, err
}

// A scan waits out an outage of ten minutes, far past the 15 seconds of
// retries it once had, and finishes in the session it started.
func TestScanWaitsOutAnOutageInItsSession(t *testing.T) {
	st, dsn := storetest.NewNamed(t)
	s := serve(t, st)
	root := t.TempDir()
	write(t, root, "a.txt", "a")
	start := time.Now()
	clock := &outageClock{now: start, until: start.Add(10 * time.Minute), down: &s.down}
	waits := 0
	scan := remote{c: client.New(s.url, s.write), waiting: func(Wait) { waits++ }, clock: clock}
	res, err := Run(t.Context(), goesDown{scan, &s.down}, at(root))
	if err != nil || res.Status != "complete" || res.Counts.Hashed != 1 {
		t.Fatalf("scan through an outage: %+v, %v", res, err)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from scans where id = $1 and status = 'complete'`, res.ScanID); n != 1 {
		t.Error("the scan did not finish in its own session")
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from scans`); n != 1 {
		t.Errorf("%d scans, want the one that waited", n)
	}
	waited := clock.Now().Sub(start)
	if waits != len(clock.pauses) || waits <= 5 || waited < 10*time.Minute || slices.Max(clock.pauses) > maxPause {
		t.Errorf("%d waits over %s, pauses %v; want more than 5 of at most %s over the outage", waits, waited, clock.pauses, maxPause)
	}
}

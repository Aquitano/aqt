// Package session keeps the scans that run on the machine with the disks and
// write the catalogue through bank serve's API. Such a scan sends its work in
// numbered batches; between them its session holds the volume's lock and the
// scan's place, and each batch is applied by the same store code a scan in
// this process calls.
package session

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/attic/disk"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
)

// IdleTimeout is how long a session waits for its scan's next request.
// Hashing one large file can take minutes, so the scan sends keepalives.
const IdleTimeout = 5 * time.Minute

// ErrNotOpen means a request named a scan that has no open session.
var ErrNotOpen = errors.New("not open")

type Manager struct {
	store *store.Store
	spool string
	idle  time.Duration

	mu       sync.Mutex
	sessions map[int64]*session
	closed   bool
	stop     chan struct{}
	stopped  chan struct{}
}

// New keeps sessions on st and spools archive listings that span batches in
// spool, a directory created when first needed.
func New(st *store.Store, spool string) *Manager {
	return &Manager{store: st, spool: spool, idle: IdleTimeout, sessions: map[int64]*session{}}
}

type session struct {
	mu    sync.Mutex
	sc    *store.Scan
	spool string
	seen  atomic.Int64
	// ended is the status the scan ended with; empty while it is open.
	ended string
	seq   int64
	last  BatchResult

	// folders are the folders named by a listing and not listed yet.
	folders map[int64]store.Dir
	// parts holds the entries of folders whose listing spans batches.
	parts map[int64][]ListedEntry
	// answers are the client's for the batch being applied, asked what the
	// batch needs and has no answer for.
	answers map[store.Location]bool
	asked   []store.Location
	// What the batch being applied changed, undone when it is not applied.
	listed   []int64
	partLen  map[int64]int
	consumed []int64

	spools map[int64]*spool
}

func (s *session) touch() { s.seen.Store(time.Now().UnixNano()) }

func (m *Manager) Resolve(ctx context.Context, r VolumeRequest) (store.Volume, error) {
	return m.store.ResolveVolume(ctx, disk.Volume(r.Mounted), r.VolumeID, r.NewVolume)
}

// Start opens a scan of a folder of a resolved volume. Only one scan of a
// volume runs at a time, here or in any other process.
func (m *Manager) Start(ctx context.Context, r ScanStart) (StartedScan, error) {
	if r.Root != "" && (!strings.HasPrefix(r.Root, "/") || strings.HasSuffix(r.Root, "/")) {
		return StartedScan{}, fail.Invalidf("root %q is not empty or a volume-relative folder such as /Files", r.Root)
	}
	v, err := m.store.Volume(ctx, r.VolumeID)
	if err != nil {
		return StartedScan{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return StartedScan{}, errors.New("bank serve is stopping")
	}
	sc, err := m.store.StartScan(ctx, v, r.Root)
	if err != nil {
		return StartedScan{}, err
	}
	s := &session{sc: sc, spool: m.spool, folders: map[int64]store.Dir{}, parts: map[int64][]ListedEntry{},
		answers: map[store.Location]bool{}, partLen: map[int64]int{}, spools: map[int64]*spool{}}
	s.touch()
	m.sessions[sc.ID] = s
	if m.stop == nil {
		m.stop, m.stopped = make(chan struct{}), make(chan struct{})
		go m.watch(m.stop, m.stopped)
		// No scan of this process spooled anything yet, so whatever is there
		// was left by one that stopped without cleaning up.
		if leftovers, err := filepath.Glob(filepath.Join(m.spool, "scan-archive-*")); err == nil && m.spool != "" {
			for _, f := range leftovers {
				_ = os.Remove(f)
			}
		}
	}
	return StartedScan{ScanID: sc.ID, IdleSeconds: int(m.idle / time.Second)}, nil
}

// Touch keeps a session open while its scan reads a file for a long time.
func (m *Manager) Touch(id int64) error {
	s, err := m.session(id)
	if err == nil {
		s.touch()
	}
	return err
}

func (m *Manager) session(id int64) (*session, error) {
	m.mu.Lock()
	s := m.sessions[id]
	m.mu.Unlock()
	if s == nil {
		return nil, fmt.Errorf("scan %d is %w: it finished, failed, or sent nothing for %s", id, ErrNotOpen, m.idle)
	}
	return s, nil
}

// use runs one request of a session's scan, after the requests before it.
func (m *Manager) use(id int64, request func(*session) error) error {
	s, err := m.session(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended != "" {
		return fmt.Errorf("scan %d is %w: it ended as %s", id, ErrNotOpen, s.ended)
	}
	s.touch()
	defer s.touch()
	return request(s)
}

// Apply applies a batch and commits it, or answers it again when it was
// applied already. A batch that fails ends its scan as failed, as an error
// ends a scan in process. The batch runs to its end even when the client
// goes away meanwhile, so the client can send it again and learn the result.
func (m *Manager) Apply(ctx context.Context, id int64, b Batch) (BatchResult, error) {
	ctx = context.WithoutCancel(ctx)
	s, err := m.session(id)
	if err != nil {
		return BatchResult{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case b.Seq == s.seq && s.seq > 0:
		return s.last, nil
	case s.ended != "":
		return BatchResult{}, fmt.Errorf("scan %d is %w: it ended as %s", id, ErrNotOpen, s.ended)
	case b.Seq != s.seq+1:
		return BatchResult{}, fail.Invalidf("batch %d cannot follow batch %d", b.Seq, s.seq)
	}
	s.touch()
	defer s.touch()
	res, err := s.apply(ctx, b)
	if err != nil {
		return BatchResult{}, errors.Join(err, s.end("failed", err))
	}
	return res, nil
}

// end closes the session's scan with status and the failure that caused it,
// which the scan records.
func (s *session) end(status string, failure error) error {
	if s.ended != "" {
		return nil
	}
	s.ended = status
	s.dropSpools()
	return s.sc.Finish(context.Background(), status, failure)
}

func (m *Manager) watch(stop <-chan struct{}, stopped chan<- struct{}) {
	tick := time.NewTicker(max(m.idle/4, time.Second))
	defer tick.Stop()
	defer close(stopped)
	for {
		select {
		case <-stop:
			return
		case now := <-tick.C:
			m.expire(now)
		}
	}
}

// expire ends the scans whose client went quiet, as interrupted: the same
// status a scan killed in process gets from the next scan of its volume.
// Ended sessions stay until then too, so a client whose answer to its last
// batch was lost can ask again.
func (m *Manager) expire(now time.Time) {
	m.mu.Lock()
	sessions := slices.Collect(maps.Values(m.sessions))
	m.mu.Unlock()
	for _, s := range sessions {
		if now.Sub(time.Unix(0, s.seen.Load())) < m.idle || !s.mu.TryLock() {
			continue
		}
		if err := s.end("interrupted", fmt.Errorf("the scanning machine sent nothing for %s", m.idle)); err != nil {
			slog.Error("end an idle scan", "scan", s.sc.ID, "error", err)
		}
		m.mu.Lock()
		delete(m.sessions, s.sc.ID)
		m.mu.Unlock()
		s.mu.Unlock()
	}
}

// Close ends every open scan as interrupted, after the requests in flight.
// bank serve calls it once its HTTP server has drained.
func (m *Manager) Close() error {
	m.mu.Lock()
	m.closed = true
	sessions := slices.Collect(maps.Values(m.sessions))
	clear(m.sessions)
	stop, stopped := m.stop, m.stopped
	m.stop = nil
	m.mu.Unlock()
	if stop != nil {
		close(stop)
		<-stopped
	}
	var errs []error
	for _, s := range sessions {
		s.mu.Lock()
		errs = append(errs, s.end("interrupted", errors.New("bank serve stopped")))
		s.mu.Unlock()
	}
	return errors.Join(errs...)
}

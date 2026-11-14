package scan

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net"
	"slices"
	"time"
	"unicode/utf8"

	"github.com/aquitano/aqt/apps/bank/internal/attic/archive"
	"github.com/aquitano/aqt/apps/bank/internal/attic/config"
	"github.com/aquitano/aqt/apps/bank/internal/attic/disk"
	"github.com/aquitano/aqt/apps/bank/internal/attic/metadata"
	"github.com/aquitano/aqt/apps/bank/internal/attic/session"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/client"
)

// A remote scan sends its writes in batches of about batchBytes or batchOps
// operations, and at least every batchEvery while it has any. It fetches work
// in pages of up to workPage items and serves the driver's smaller pages
// from them.
const (
	batchBytes   = 4 << 20
	batchOps     = 5000
	batchEvery   = 5 * time.Second
	listingPart  = 10000
	archiveChunk = 5000
	workPage     = 2000
	// requestTimeout bounds one request, so a connection that stalls is
	// retried instead of holding the scan forever.
	requestTimeout = 5 * time.Minute
)

// Remote writes the catalogue through bank serve's API, with a client whose
// token writes.
func Remote(c *client.Client) Catalogue { return remote{c} }

type remote struct{ c *client.Client }

func (r remote) ResolveVolume(ctx context.Context, mounted disk.Volume, forceID string, forceNew bool) (store.Volume, error) {
	mounted.Label, mounted.Root = store.CleanText(mounted.Label), store.CleanText(mounted.Root)
	return r.c.ResolveVolume(ctx, session.VolumeRequest{Mounted: session.MountedVolume(mounted), VolumeID: forceID, NewVolume: forceNew})
}

func (r remote) StartScan(ctx context.Context, v store.Volume, root string) (Session, error) {
	// Postgres refuses such a root, so a scan in process stops here too.
	if !utf8.ValidString(root) {
		return nil, fmt.Errorf("%q is not valid Unicode, so the catalogue cannot record it as a scan root", root)
	}
	started, err := r.c.StartScan(ctx, session.ScanStart{VolumeID: v.ID, Root: root})
	if err != nil {
		return nil, err
	}
	s := &remoteScan{c: r.c, id: started.ScanID, stableIDs: v.StableIDs, lastFlush: time.Now(),
		reusable: map[int64]bool{}, linked: map[int64][]linkStamp{}, listed: map[int64]bool{},
		stop: make(chan struct{}), stopped: make(chan struct{})}
	go s.keepAlive(max(time.Duration(started.IdleSeconds)*time.Second/4, time.Second))
	return s, nil
}

type remoteScan struct {
	c         *client.Client
	id        int64
	stableIDs bool
	holds     func(string, int64) bool

	// counts are the server's as of the last batch. skipped and members are
	// what this side added since, so progress moves between batches.
	counts       store.ScanCounts
	skipped      int64
	members      int64
	finalMembers int64

	seq       int64
	ops       []session.Op
	size      int
	lastFlush time.Time
	folders   int64

	hashes   pages[store.Pending]
	archives pages[store.PendingArchive]
	texts    pages[store.PendingText]
	metadata pages[store.ContentFile]

	// reusable are pending files whose page said a link holds their digest.
	// linked are the stamps of links this scan gave a digest, by file id.
	reusable map[int64]bool
	linked   map[int64][]linkStamp
	// listed are the contents this scan sent a finished listing for.
	listed map[int64]bool

	stop, stopped chan struct{}
}

type linkStamp struct{ size, modified, changed int64 }

func (s *remoteScan) ID() int64 { return s.id }

func (s *remoteScan) Counts() store.ScanCounts {
	c := s.counts
	c.Skipped += s.skipped
	c.Members += s.members
	return c
}

func (s *remoteScan) keepAlive(every time.Duration) {
	defer close(s.stopped)
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-tick.C:
			ctx, cancel := context.WithTimeout(context.Background(), every)
			_ = s.c.KeepScanAlive(ctx, s.id)
			cancel()
		}
	}
}

// add appends an operation of about size bytes to the batch being built.
func (s *remoteScan) add(op session.Op, size int) {
	s.ops = append(s.ops, op)
	s.size += size
}

// queue is add, sending the batch first when the operation would take it
// past batchBytes.
func (s *remoteScan) queue(ctx context.Context, op session.Op, size int) error {
	if len(s.ops) > 0 && s.size+size > batchBytes {
		if err := s.flush(ctx); err != nil {
			return err
		}
	}
	s.add(op, size)
	return nil
}

func (s *remoteScan) MaybeCommit(ctx context.Context) error {
	if len(s.ops) >= batchOps || s.size >= batchBytes || len(s.ops) > 0 && time.Since(s.lastFlush) >= batchEvery {
		return s.flush(ctx)
	}
	return nil
}

func (s *remoteScan) Commit(ctx context.Context) error { return s.flush(ctx) }

// flush sends the batch built so far. It stays queued until the server
// answers, so the next attempt sends it again under the same number.
func (s *remoteScan) flush(ctx context.Context) error {
	if len(s.ops) == 0 {
		return nil
	}
	res, err := s.send(ctx, session.Batch{Seq: s.seq + 1, Ops: s.ops})
	if err != nil {
		return err
	}
	s.applied(res)
	return nil
}

func (s *remoteScan) applied(res session.BatchResult) {
	s.seq++
	s.ops, s.size, s.lastFlush = nil, 0, time.Now()
	s.counts, s.skipped = res.Counts, 0
	s.members -= s.finalMembers
	s.finalMembers = 0
}

// send delivers a batch: again with answers while the server has questions,
// and again unchanged when the connection fails, which the batch's number
// makes harmless.
func (s *remoteScan) send(ctx context.Context, b session.Batch) (session.BatchResult, error) {
	answered := map[store.Location]bool{}
	for {
		res, err := retry(ctx, func(ctx context.Context) (session.BatchResult, error) { return s.c.WriteScan(ctx, s.id, b) })
		if err != nil || len(res.Questions) == 0 {
			return res, err
		}
		for _, q := range res.Questions {
			if answered[q] {
				return res, fmt.Errorf("bank serve asked again whether %s holds file %d", q.Path, q.FileID)
			}
			answered[q] = true
			b.Answers = append(b.Answers, session.HoldsAnswer{Location: q, Holds: s.holds(q.Path, q.FileID)})
		}
	}
}

// retry repeats a call whose connection failed or stalled. A call the server
// answered, even with an error, is not repeated.
func retry[T any](ctx context.Context, call func(context.Context) (T, error)) (T, error) {
	for attempt := 0; ; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, requestTimeout)
		v, err := call(attemptCtx)
		cancel()
		if err == nil || attempt == 4 || ctx.Err() != nil ||
			!errors.As(err, new(net.Error)) && !errors.Is(err, io.ErrUnexpectedEOF) {
			return v, err
		}
		select {
		case <-ctx.Done():
			return v, err
		case <-time.After(time.Second << attempt):
		}
	}
}

func (s *remoteScan) Finish(ctx context.Context, status string, phases store.PhaseTimes, failure error) (int64, error) {
	ctx = context.WithoutCancel(ctx)
	close(s.stop)
	<-s.stopped
	finish := &session.FinishRequest{Status: status, Phases: phases}
	if failure != nil {
		finish.Error = store.CleanText(failure.Error())
	}
	res, err := s.send(ctx, session.Batch{Seq: s.seq + 1, Ops: s.ops, Finish: finish})
	if err == nil && !res.Finished {
		// The batch had been applied and its answer lost; finish after it.
		s.applied(res)
		res, err = s.send(ctx, session.Batch{Seq: s.seq + 1, Finish: finish})
	}
	if err != nil {
		return 0, err
	}
	s.applied(res)
	return res.Pending, nil
}

func (s *remoteScan) Skip(entryPath, reason, rule, detail string) {
	s.add(session.Op{Skip: &session.ScanSkip{Path: store.CleanText(entryPath), Reason: reason, Rule: rule,
		Detail: store.CleanText(detail)}}, len(entryPath)+len(detail)+64)
	s.skipped++
}

func (s *remoteScan) SetStatus(ctx context.Context, status string) error {
	return s.queue(ctx, session.Op{Status: status}, 32)
}

// ApplyListing queues the listing and answers with the folders it names,
// numbered for the folder's own listing. The server asks for holds when it
// applies the listing.
func (s *remoteScan) ApplyListing(ctx context.Context, parent *store.Dir, listed []store.Listed, keep map[string]bool, complete bool,
	holds func(string, int64) bool) ([]store.Dir, error) {
	s.holds = holds
	l := session.FolderListing{Complete: complete}
	if parent != nil {
		l.Folder = parent.ID
	}
	var dirs []store.Dir
	for _, e := range listed {
		entry := session.ListedEntry{Name: []byte(e.Name), Kind: e.Kind, FileID: e.FileID, Size: e.Size, Created: e.Created,
			Modified: e.Modified, Accessed: e.Accessed, Changed: e.Changed, Attributes: e.Attributes, HashState: e.HashState}
		if e.Kind == "dir" {
			s.folders++
			entry.Folder = s.folders
			dir := store.Dir{ID: s.folders}
			if parent != nil {
				dir.Path = parent.Path + "/" + store.CleanText(e.Name)
			}
			dirs = append(dirs, dir)
		}
		l.Entries = append(l.Entries, entry)
	}
	for _, name := range slices.Sorted(maps.Keys(keep)) {
		l.Keep = append(l.Keep, []byte(name))
	}
	for len(l.Entries) > listingPart {
		part := session.FolderListing{Folder: l.Folder, Entries: l.Entries[:listingPart], More: true}
		l.Entries = l.Entries[listingPart:]
		if err := s.queue(ctx, session.Op{Listing: &part}, listingSize(part.Entries)); err != nil {
			return nil, err
		}
	}
	return dirs, s.queue(ctx, session.Op{Listing: &l}, listingSize(l.Entries)+64*len(l.Keep))
}

func listingSize(entries []session.ListedEntry) int {
	n := 0
	for _, e := range entries {
		n += len(e.Name)*4/3 + 256
	}
	return n
}

// SetGitRemote rides on the folder's listing, which the driver queued just
// before.
func (s *remoteScan) SetGitRemote(_ context.Context, dir store.Dir, remote string) error {
	if len(s.ops) > 0 {
		if l := s.ops[len(s.ops)-1].Listing; l != nil && l.Folder == dir.ID && !l.More {
			remote = store.CleanText(remote)
			l.GitRemote = &remote
			return nil
		}
	}
	return fmt.Errorf("%s: the git remote has no listing to go with", dir.Path)
}

func (s *remoteScan) QueueHardLinkHashes(ctx context.Context) error {
	return s.queue(ctx, session.Op{HardLinks: true}, 32)
}

// pages serves the driver's pages out of larger ones, each fetched after
// the writes before it are sent.
type pages[T any] struct{ items []T }

func (p *pages[T]) next(ctx context.Context, s *remoteScan, start bool, limit int, fetch func(context.Context) ([]T, error)) ([]T, error) {
	if start {
		p.items = nil
	}
	if len(p.items) == 0 {
		if err := s.flush(ctx); err != nil {
			return nil, err
		}
		items, err := retry(ctx, fetch)
		if err != nil {
			return nil, err
		}
		p.items = items
	}
	n := min(limit, len(p.items))
	page := p.items[:n:n]
	p.items = p.items[n:]
	return page, nil
}

func (s *remoteScan) PendingTotals(ctx context.Context) (int64, int64, error) {
	if err := s.flush(ctx); err != nil {
		return 0, 0, err
	}
	w, err := retry(ctx, func(ctx context.Context) (session.Work[session.HashWork], error) {
		return s.c.ScanHashWork(ctx, s.id, session.WorkRequest{Count: true})
	})
	return w.Total, w.Bytes, err
}

func (s *remoteScan) NextPending(ctx context.Context, after store.Pending, limit int) ([]store.Pending, error) {
	return s.hashes.next(ctx, s, after.ID == 0, limit, func(ctx context.Context) ([]store.Pending, error) {
		w, err := s.c.ScanHashWork(ctx, s.id, session.WorkRequest{AfterPath: after.Path, AfterID: after.ID, Limit: workPage})
		page := make([]store.Pending, len(w.Items))
		for i, h := range w.Items {
			page[i] = h.Pending
			if h.Reusable {
				s.reusable[h.ID] = true
			}
		}
		return page, err
	})
}

func (s *remoteScan) SetContent(ctx context.Context, p store.Pending, digest [32]byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if stamp, ok := stampOf(p); ok && p.Linked && !slices.Contains(s.linked[*p.PhysicalFileID], stamp) {
		s.linked[*p.PhysicalFileID] = append(s.linked[*p.PhysicalFileID], stamp)
	}
	return s.queue(ctx, session.Op{Hash: &session.HashResult{File: p, Digest: digest}}, len(p.Path)+256)
}

func stampOf(p store.Pending) (linkStamp, bool) {
	if p.PhysicalFileID == nil || p.Modified == nil || p.Changed == nil {
		return linkStamp{}, false
	}
	return linkStamp{size: p.Size, modified: p.Modified.UnixMicro(), changed: p.Changed.UnixMicro()}, true
}

// ReuseContent takes a link's digest when ReuseContent in process would: the
// page said a trusted link holds it, or this scan gave one a digest under the
// same stamp before. Either holds until the server applies it unless
// something outside the scan writes the entries meanwhile.
func (s *remoteScan) ReuseContent(ctx context.Context, p store.Pending, observed disk.Entry) (bool, error) {
	reusable := s.reusable[p.ID]
	delete(s.reusable, p.ID)
	if !s.stableIDs || p.PhysicalFileID == nil || int64(observed.FileID) != *p.PhysicalFileID ||
		observed.Dir || observed.Link || observed.Remote || observed.Size != p.Size ||
		observed.Modified.IsZero() || observed.Changed.IsZero() {
		return false, nil
	}
	stamp, ok := stampOf(p)
	if !ok || !reusable && !slices.Contains(s.linked[*p.PhysicalFileID], stamp) {
		return false, nil
	}
	if !slices.Contains(s.linked[*p.PhysicalFileID], stamp) {
		s.linked[*p.PhysicalFileID] = append(s.linked[*p.PhysicalFileID], stamp)
	}
	reuse := &session.LinkReuse{File: p, Modified: observed.Modified.UTC().Truncate(time.Microsecond),
		Changed: observed.Changed.UTC().Truncate(time.Microsecond)}
	return true, s.queue(ctx, session.Op{Reuse: reuse}, len(p.Path)+256)
}

func (s *remoteScan) HashFailed(ctx context.Context, p store.Pending, failure error) error {
	s.skipped++
	return s.queue(ctx, session.Op{HashFailed: &session.HashFailure{File: p, Error: store.CleanText(failure.Error())}}, len(p.Path)+512)
}

func (s *remoteScan) SkipHash(ctx context.Context, p store.Pending, reason, rule, detail string) error {
	s.skipped++
	return s.queue(ctx, session.Op{SkipHash: &session.HashSkip{File: p, Reason: reason, Rule: rule, Detail: store.CleanText(detail)}},
		len(p.Path)+256)
}

func (s *remoteScan) RebuildContent(ctx context.Context) error {
	return s.queue(ctx, session.Op{Rebuild: true}, 32)
}

func archiveWork(ranges []config.ArchiveRange, unpackMaxBytes int64) session.WorkRequest {
	r := session.WorkRequest{UnpackMaxBytes: unpackMaxBytes, Ranges: make([]session.ArchivePolicyRange, len(ranges))}
	for i, p := range ranges {
		r.Ranges[i] = session.ArchivePolicyRange(p)
	}
	return r
}

func (s *remoteScan) ArchiveTotals(ctx context.Context, ranges []config.ArchiveRange, unpackMaxBytes int64) (int64, error) {
	if err := s.flush(ctx); err != nil {
		return 0, err
	}
	r := archiveWork(ranges, unpackMaxBytes)
	r.Count = true
	w, err := retry(ctx, func(ctx context.Context) (session.Work[store.PendingArchive], error) {
		return s.c.ScanArchiveWork(ctx, s.id, r)
	})
	return w.Total, err
}

func (s *remoteScan) NextArchives(ctx context.Context, after store.PendingArchive, limit int, ranges []config.ArchiveRange,
	unpackMaxBytes int64) ([]store.PendingArchive, error) {
	return s.archives.next(ctx, s, after.ID == 0, limit, func(ctx context.Context) ([]store.PendingArchive, error) {
		r := archiveWork(ranges, unpackMaxBytes)
		r.AfterPath, r.AfterID, r.Limit = after.Path, after.ID, workPage
		w, err := s.c.ScanArchiveWork(ctx, s.id, r)
		return w.Items, err
	})
}

// StartListing trusts the page the archive came from, which said its content
// needs a listing, unless this scan listed that content since; then it asks.
func (s *remoteScan) StartListing(ctx context.Context, contentID int64, depth int, unpackMaxBytes int64) (Listing, error) {
	if s.listed[contentID] {
		if err := s.flush(ctx); err != nil {
			return nil, err
		}
		check := session.ListingCheck{ContentID: contentID, Depth: depth, UnpackMaxBytes: unpackMaxBytes}
		n, err := retry(ctx, func(ctx context.Context) (session.ListingNeeded, error) {
			return s.c.CheckScanListing(ctx, s.id, check)
		})
		if err != nil || !n.Needed {
			return nil, err
		}
	}
	return &remoteListing{s: s, chunk: session.ArchiveChunk{ContentID: contentID, Depth: depth, UnpackMaxBytes: unpackMaxBytes}}, nil
}

// remoteListing sends members in chunks. The server keeps them aside and
// applies the listing in one transaction when the outcome arrives.
type remoteListing struct {
	s       *remoteScan
	chunk   session.ArchiveChunk
	size    int
	members int64
	sent    bool
}

func (l *remoteListing) Add(ctx context.Context, m archive.Member) error {
	modified := m.Modified
	// A tar header can claim any year; JSON and Postgres stop at 9999.
	if y := modified.Year(); y < 1 || y > 9999 {
		modified = time.Time{}
	}
	l.chunk.Members = append(l.chunk.Members, session.ArchiveMember{Path: store.CleanText(m.Path), Name: store.CleanText(m.Name),
		Kind: m.Kind, Size: m.Size, Modified: modified, CRC32: m.CRC32, Encrypted: m.Encrypted})
	l.size += len(m.Path) + len(m.Name) + 128
	l.members++
	l.s.members++
	if len(l.chunk.Members) < archiveChunk {
		return nil
	}
	chunk, size := l.chunk, l.size
	l.chunk.Members, l.size, l.sent = nil, 0, true
	return l.s.queue(ctx, session.Op{Archive: &chunk}, size)
}

func (l *remoteListing) Finish(ctx context.Context, res archive.Result) error {
	chunk := l.chunk
	chunk.Outcome = &session.ArchiveOutcome{Format: res.Format, Status: res.Status, Detail: store.CleanText(res.Detail),
		Incomplete: res.Incomplete, CacheableFailure: res.CacheableFailure}
	if err := l.s.queue(ctx, session.Op{Archive: &chunk}, l.size+len(res.Detail)+128); err != nil {
		return err
	}
	l.s.finalMembers += l.members
	l.s.listed[chunk.ContentID] = true
	return nil
}

func (l *remoteListing) Abort(context.Context) {
	l.s.members -= l.members
	if l.sent {
		l.s.add(session.Op{Archive: &session.ArchiveChunk{ContentID: l.chunk.ContentID, Abort: true}}, 64)
	}
}

func (s *remoteScan) ArchivePart(ctx context.Context, path string) (store.Stamp, error) {
	if err := s.flush(ctx); err != nil {
		return store.Stamp{}, err
	}
	stamp, err := retry(ctx, func(ctx context.Context) (store.Stamp, error) { return s.c.ScanArchivePart(ctx, s.id, path) })
	if e, ok := errors.AsType[*client.Error](err); ok && e.Tag == "NotFound" {
		return stamp, notFound{e}
	}
	return stamp, err
}

// notFound is the server's NotFound as the catalogue's own.
type notFound struct{ cause error }

func (e notFound) Error() string      { return e.cause.Error() }
func (notFound) Is(target error) bool { return target == store.ErrNotFound }

func (s *remoteScan) TextTotals(ctx context.Context, exts []string) (int64, error) {
	if err := s.flush(ctx); err != nil {
		return 0, err
	}
	w, err := retry(ctx, func(ctx context.Context) (session.Work[store.PendingText], error) {
		return s.c.ScanTextWork(ctx, s.id, session.WorkRequest{Count: true, Extensions: exts})
	})
	return w.Total, err
}

func (s *remoteScan) NextTexts(ctx context.Context, after store.PendingText, exts []string, limit int) ([]store.PendingText, error) {
	return s.texts.next(ctx, s, after.ID == 0, limit, func(ctx context.Context) ([]store.PendingText, error) {
		w, err := s.c.ScanTextWork(ctx, s.id, session.WorkRequest{AfterPath: after.Path, AfterID: after.ID, Limit: workPage, Extensions: exts})
		return w.Items, err
	})
}

func (s *remoteScan) SetText(ctx context.Context, contentID int64, t store.DocumentText) error {
	t.Detail, t.Text = store.CleanText(t.Detail), store.CleanText(t.Text)
	return s.queue(ctx, session.Op{Text: &session.DocumentResult{ContentID: contentID, Text: t}}, len(t.Text)+len(t.Detail)+256)
}

func (s *remoteScan) MetadataTotals(ctx context.Context) (int64, error) {
	if err := s.flush(ctx); err != nil {
		return 0, err
	}
	w, err := retry(ctx, func(ctx context.Context) (session.Work[session.MetadataWork], error) {
		return s.c.ScanMetadataWork(ctx, s.id, session.WorkRequest{Count: true})
	})
	return w.Total, err
}

func (s *remoteScan) NextMetadata(ctx context.Context, after store.ContentFile, limit int) ([]store.ContentFile, error) {
	return s.metadata.next(ctx, s, after.ID == 0, limit, func(ctx context.Context) ([]store.ContentFile, error) {
		w, err := s.c.ScanMetadataWork(ctx, s.id, session.WorkRequest{AfterPath: after.Path, AfterID: after.ID, Limit: workPage})
		page := make([]store.ContentFile, len(w.Items))
		for i, m := range w.Items {
			page[i] = store.ContentFile{ID: m.ID, Path: m.Path, ContentID: m.ContentID, Size: m.Size, Stamp: m.Stamp}
		}
		return page, err
	})
}

func (s *remoteScan) SetMetadata(ctx context.Context, contentID int64, result metadata.Result) error {
	result.Detail = store.CleanText(result.Detail)
	encoded, err := json.Marshal(result)
	if err != nil {
		return err
	}
	return s.queue(ctx, session.Op{Metadata: &session.MetadataResult{ContentID: contentID, Result: session.ExifResult(result)}}, len(encoded)+128)
}

package session

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"slices"

	"github.com/aquitano/aqt/apps/bank/internal/attic/disk"
	"github.com/aquitano/aqt/apps/bank/internal/attic/metadata"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/attic/unpack"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
)

// apply runs a batch's operations in order and commits them. When a listing
// needs to know whether a path still holds a file, which only the client can
// tell, the batch is rolled back and returns every such question; the client
// sends it again with the answers. Only listings ask, and a scan lists before
// it does anything else, so a batch rolled back holds nothing that commits on
// its own.
func (s *session) apply(ctx context.Context, b Batch) (BatchResult, error) {
	for _, a := range b.Answers {
		s.answers[a.Location] = a.Holds
	}
	mark := s.sc.Mark()
	s.asked, s.listed, s.consumed = s.asked[:0], s.listed[:0], s.consumed[:0]
	clear(s.partLen)
	for i := range b.Ops {
		if err := s.op(ctx, &b.Ops[i]); err != nil {
			return BatchResult{}, err
		}
	}
	if len(s.asked) > 0 {
		questions := slices.Clone(s.asked)
		s.rollback()
		return BatchResult{Counts: s.sc.Counts, Questions: questions}, s.sc.Rewind(ctx, mark, questions)
	}
	clear(s.answers)
	for _, f := range s.listed {
		delete(s.folders, f)
	}
	for _, f := range s.consumed {
		delete(s.parts, f)
	}
	var res BatchResult
	if f := b.Finish; f != nil {
		var failure error
		if f.Error != "" {
			failure = errors.New(f.Error)
		}
		s.sc.Phases = f.Phases
		if err := s.end(f.Status, failure); err != nil {
			return BatchResult{}, err
		}
		files, _, err := s.sc.PendingTotals(ctx)
		if err != nil {
			return BatchResult{}, err
		}
		res.Finished, res.Pending = true, files
	} else if err := s.sc.Commit(ctx); err != nil {
		return BatchResult{}, err
	}
	res.Counts = s.sc.Counts
	s.seq, s.last = b.Seq, res
	return res, nil
}

// rollback forgets the parts of folder listings the batch added or used.
func (s *session) rollback() {
	for f, n := range s.partLen {
		if n < 0 {
			delete(s.parts, f)
		} else {
			s.parts[f] = s.parts[f][:n]
		}
	}
}

func (s *session) op(ctx context.Context, op *Op) error {
	sc := s.sc
	switch {
	case op.Status != "":
		return sc.SetStatus(ctx, op.Status)
	case op.Skip != nil:
		sc.Skip(op.Skip.Path, op.Skip.Reason, op.Skip.Rule, op.Skip.Detail)
		return nil
	case op.Listing != nil:
		return s.listing(ctx, op.Listing)
	case op.HardLinks:
		return sc.QueueHardLinkHashes(ctx)
	case op.Hash != nil:
		return sc.SetContent(ctx, op.Hash.File, op.Hash.Digest)
	case op.Reuse != nil:
		return s.reuse(ctx, op.Reuse)
	case op.HashFailed != nil:
		return sc.HashFailed(ctx, op.HashFailed.File, errors.New(op.HashFailed.Error))
	case op.SkipHash != nil:
		h := op.SkipHash
		return sc.SkipHash(ctx, h.File, h.Reason, h.Rule, h.Detail)
	case op.Rebuild:
		return sc.RebuildContent(ctx)
	case op.Archive != nil:
		return s.archive(ctx, op.Archive)
	case op.Text != nil:
		return sc.SetText(ctx, op.Text.ContentID, op.Text.Text)
	case op.Metadata != nil:
		return sc.SetMetadata(ctx, op.Metadata.ContentID, metadata.Result(op.Metadata.Result))
	}
	return fail.Invalidf("an operation sets none of its fields")
}

func (s *session) listing(ctx context.Context, l *FolderListing) error {
	if _, ok := s.partLen[l.Folder]; !ok {
		n, ok := s.parts[l.Folder]
		s.partLen[l.Folder] = len(n)
		if !ok {
			s.partLen[l.Folder] = -1
		}
	}
	if l.More {
		s.parts[l.Folder] = append(s.parts[l.Folder], l.Entries...)
		return nil
	}
	entries := l.Entries
	if part, ok := s.parts[l.Folder]; ok {
		entries = append(slices.Clip(part), entries...)
		s.consumed = append(s.consumed, l.Folder)
	}
	var parent *store.Dir
	if l.Folder != 0 {
		d, ok := s.folders[l.Folder]
		if !ok {
			return fail.Invalidf("no listing named folder %d", l.Folder)
		}
		parent = &d
	}
	listed := make([]store.Listed, len(entries))
	dirs := 0
	for i, e := range entries {
		listed[i] = store.Listed{Name: string(e.Name), Kind: e.Kind, FileID: e.FileID, Size: e.Size, Created: e.Created,
			Modified: e.Modified, Accessed: e.Accessed, Changed: e.Changed, Attributes: e.Attributes, HashState: e.HashState}
		if e.Kind == "dir" {
			dirs++
		}
	}
	keep := make(map[string]bool, len(l.Keep))
	for _, name := range l.Keep {
		keep[string(name)] = true
	}
	children, err := s.sc.ApplyListing(ctx, parent, listed, keep, l.Complete, s.holds)
	if err != nil {
		return err
	}
	if len(children) != dirs {
		return fail.Invalidf("folder %d: %d subfolders listed, %d recorded", l.Folder, dirs, len(children))
	}
	next := 0
	for _, e := range entries {
		if e.Kind == "dir" {
			s.folders[e.Folder] = children[next]
			next++
		}
	}
	if parent == nil {
		return nil
	}
	s.listed = append(s.listed, l.Folder)
	if l.GitRemote == nil {
		return nil
	}
	return s.sc.SetGitRemote(ctx, *parent, *l.GitRemote)
}

// holds answers ApplyListing from the client's answers. A question without
// one is noted, and the batch it came from is not applied.
func (s *session) holds(path string, fileID int64) bool {
	l := store.Location{Path: path, FileID: fileID}
	if held, ok := s.answers[l]; ok {
		return held
	}
	s.asked = append(s.asked, l)
	return true
}

// reuse applies a reuse the client chose because the page said a link held
// the digest. Only a writer outside the scan can have changed that since, so
// a reuse that no longer applies is a file that changed: the next scan
// hashes it.
func (s *session) reuse(ctx context.Context, r *LinkReuse) error {
	observed := disk.Entry{Size: r.File.Size, Modified: r.Modified, Changed: r.Changed}
	if r.File.PhysicalFileID != nil {
		observed.FileID = uint64(*r.File.PhysicalFileID)
	}
	reused, err := s.sc.ReuseContent(ctx, r.File, observed)
	if err != nil || reused {
		return err
	}
	s.sc.Skip(r.File.Path, "changed", "", "its hard link's digest no longer applies; hashed on the next scan")
	return nil
}

// spool keeps the members of an archive listing that spans batches on disk,
// so a large archive costs the server neither memory nor a transaction held
// open between requests.
type spool struct {
	file *os.File
	w    *bufio.Writer
}

func (s *session) archive(ctx context.Context, a *ArchiveChunk) error {
	if a.Abort || a.Outcome == nil {
		if a.Abort {
			s.dropSpool(a.ContentID)
			return nil
		}
		return s.spoolMembers(a)
	}
	defer s.dropSpool(a.ContentID)
	l, err := s.sc.StartListing(ctx, a.ContentID, a.Depth, a.UnpackMaxBytes)
	if err != nil || l == nil {
		return err
	}
	add := func(m ArchiveMember) error {
		return l.Add(ctx, unpack.Member{Path: m.Path, Name: m.Name, Kind: m.Kind, Size: m.Size, Modified: m.Modified,
			CRC32: m.CRC32, Encrypted: m.Encrypted})
	}
	if err := s.replay(a.ContentID, add); err != nil {
		l.Abort(ctx)
		return err
	}
	for _, m := range a.Members {
		if err := add(m); err != nil {
			l.Abort(ctx)
			return err
		}
	}
	o := a.Outcome
	return l.Finish(ctx, unpack.Result{Format: o.Format, Status: o.Status, Detail: o.Detail, Incomplete: o.Incomplete,
		CacheableFailure: o.CacheableFailure})
}

func (s *session) spoolMembers(a *ArchiveChunk) error {
	sp := s.spools[a.ContentID]
	if sp == nil {
		if s.spool != "" {
			if err := os.MkdirAll(s.spool, 0o700); err != nil {
				return err
			}
		}
		f, err := os.CreateTemp(s.spool, "scan-archive-*.jsonl")
		if err != nil {
			return err
		}
		sp = &spool{file: f, w: bufio.NewWriter(f)}
		s.spools[a.ContentID] = sp
	}
	enc := json.NewEncoder(sp.w)
	for _, m := range a.Members {
		if err := enc.Encode(m); err != nil {
			return err
		}
	}
	return nil
}

func (s *session) replay(contentID int64, add func(ArchiveMember) error) error {
	sp := s.spools[contentID]
	if sp == nil {
		return nil
	}
	if err := sp.w.Flush(); err != nil {
		return err
	}
	if _, err := sp.file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	dec := json.NewDecoder(bufio.NewReader(sp.file))
	for {
		var m ArchiveMember
		if err := dec.Decode(&m); errors.Is(err, io.EOF) {
			return nil
		} else if err != nil {
			return err
		}
		if err := add(m); err != nil {
			return err
		}
	}
}

func (s *session) dropSpool(contentID int64) {
	if sp := s.spools[contentID]; sp != nil {
		_ = sp.file.Close()
		_ = os.Remove(sp.file.Name())
		delete(s.spools, contentID)
	}
}

func (s *session) dropSpools() {
	for id := range s.spools {
		s.dropSpool(id)
	}
}

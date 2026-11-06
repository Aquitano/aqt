package scan

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/aquitano/aqt/apps/attic/internal/archive"
	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/scratch"
	"github.com/aquitano/aqt/apps/attic/internal/store"
)

var errChanged = errors.New("file does not match its catalogued hash or stamp")

// Legacy digests have no proven timestamp baseline. Verify them through the
// held handle, as on file systems without reliable change times.
func (r *run) hold(ctx context.Context, path string, stamp store.Stamp) (*disk.Held, error) {
	f, err := disk.Hold(path)
	if err != nil {
		return nil, err
	}
	if !stamp.Matches(f.Entry) {
		f.Close()
		return nil, errChanged
	}
	if stamp.Trusted && r.changeTimes && stamp.Changed != nil {
		return f, nil
	}
	same, err := f.Verify(ctx, stamp.Digest)
	if err == nil && !same {
		err = errChanged
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// Restore the timestamp baseline before releasing the held object.
func (r *run) release(f *disk.Held) {
	if err := errors.Join(f.Restore(), f.Close()); err != nil {
		r.log.Warn("last-access time not restored", "path", f.Name(), "err", err)
	}
}

func (r *run) toolCopy(ctx context.Context, source string, stamp store.Stamp, maxBytes int64) (*scratch.Workspace, string, error) {
	f, err := disk.Hold(source)
	if err != nil {
		return nil, "", err
	}
	defer r.release(f)
	if !stamp.Matches(f.Entry) {
		return nil, "", errChanged
	}
	w, err := scratch.New(r.o.Config.Temp, r.log)
	if err != nil {
		return nil, "", scratch.WriteError{Err: err}
	}
	path, err := w.CopyOpen(ctx, f.File, stamp.Digest, maxBytes)
	if err != nil {
		r.closeScratch(w)
		return nil, "", err
	}
	return w, path, nil
}

func (r *run) closeScratch(w *scratch.Workspace) {
	if err := w.Close(); err != nil {
		r.log.Warn("scratch cleanup will retry later", "err", err)
	}
}

func (r *run) readFailure(ctx context.Context, path string, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if gone := r.volumeGone(); gone != nil {
		return gone
	}
	if errors.As(err, new(scratch.WriteError)) {
		return err
	}
	reason := "unreadable"
	if errors.Is(err, errChanged) || errors.Is(err, scratch.ErrChanged) || errors.Is(err, disk.ErrInUse) || errors.Is(err, store.ErrNotFound) {
		reason = "changed"
	}
	r.sc.Skip(path, reason, "", err.Error())
	r.log.Warn("file not read; the next scan tries again", "path", path, "err", err)
	return nil
}

// archiveFiles opens an archive and its multipart siblings in place.
type archiveFiles struct {
	r         *run
	ctx       context.Context
	source    string
	stamp     store.Stamp
	failure   error
	fatal     error
	held      map[string]*disk.Held
	multipart bool
}

func (a *archiveFiles) open(path string) (archive.Handle, error) {
	if f := a.held[path]; f != nil {
		return archiveReader{SectionReader: io.NewSectionReader(f, 0, f.Entry.Size), file: f}, nil
	}
	stamp := a.stamp
	if path != a.source {
		a.multipart = true
		var err error
		if stamp, err = a.sibling(path); err != nil {
			return nil, err
		}
	}
	f, err := a.r.hold(a.ctx, path, stamp)
	if err != nil {
		a.failure = err
		return nil, err
	}
	if a.held == nil {
		a.held = map[string]*disk.Held{}
	}
	a.held[path] = f
	return archiveReader{SectionReader: io.NewSectionReader(f, 0, f.Entry.Size), file: f}, nil
}

func (a *archiveFiles) close() {
	for _, f := range a.held {
		a.r.release(f)
	}
	a.held = nil
}

type archiveReader struct {
	*io.SectionReader
	file *disk.Held
}

func (f archiveReader) Stat() (fs.FileInfo, error) { return f.file.Stat() }
func (f archiveReader) Close() error               { return nil }

func (a *archiveFiles) sibling(path string) (store.Stamp, error) {
	if filepath.Dir(path) != filepath.Dir(a.source) {
		a.failure = fmt.Errorf("archive part is outside its source directory: %s", path)
		return store.Stamp{}, a.failure
	}
	if _, err := disk.Stat(path); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			a.failure = err
		}
		return store.Stamp{}, &os.PathError{Op: "open", Path: path, Err: err}
	}
	rel, err := filepath.Rel(a.r.mountRoot, path)
	if err != nil || !filepath.IsLocal(rel) {
		a.failure = fmt.Errorf("archive part is outside its volume: %s", path)
		return store.Stamp{}, a.failure
	}
	rel = "/" + filepath.ToSlash(rel)
	if a.r.rulesFor(rel).SkipContent(rel) {
		a.failure = fmt.Errorf("archive part is excluded by current rules: %s", rel)
		return store.Stamp{}, a.failure
	}
	stamp, err := a.r.sc.ArchivePart(a.ctx, rel)
	if err != nil {
		a.failure = err
		if !errors.Is(err, store.ErrNotFound) {
			a.fatal = err
		}
	}
	return stamp, err
}

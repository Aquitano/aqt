package scan

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/aquitano/aqt/apps/attic/internal/archive"
	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/store"
)

var errChanged = errors.New("file changed since it was hashed; the next scan hashes it again")

// hold opens a hashed file so that nothing can write to it while it is read,
// and checks that it still looks as the catalogue saw it. What is read through
// it then describes the bytes behind the entry's digest. Without a change time
// to compare, as on FAT and exFAT, a same-size rewrite that kept its modified
// time would pass, so there the file is hashed again through the held handle.
func (r *run) hold(ctx context.Context, path string, stamp store.Stamp) (*disk.Held, error) {
	f, err := disk.Hold(path)
	if err != nil {
		return nil, err
	}
	if !stamp.Matches(f.Entry) {
		f.Close()
		return nil, errChanged
	}
	if r.changeTimes && stamp.Changed != nil {
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

// release puts back the last-access time an external tool's read moved.
func (r *run) release(f *disk.Held) {
	if err := errors.Join(f.Restore(), f.Close()); err != nil {
		r.log.Warn("last-access time not restored", "path", f.Name(), "err", err)
	}
}

func (r *run) readFailure(ctx context.Context, path string, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if gone := r.volumeGone(); gone != nil {
		return gone
	}
	reason := "unreadable"
	if errors.Is(err, errChanged) || errors.Is(err, disk.ErrInUse) || errors.Is(err, store.ErrNotFound) {
		reason = "changed"
	}
	r.sc.Skip(path, reason, "", err.Error())
	r.log.Warn("file not read; the next scan tries again", "path", path, "err", err)
	return nil
}

// archiveFiles opens an archive and its multipart siblings in place.
type archiveFiles struct {
	r       *run
	ctx     context.Context
	source  string
	stamp   store.Stamp
	failure error
	fatal   error
}

func (a *archiveFiles) open(path string) (archive.Handle, error) {
	stamp := a.stamp
	if path != a.source {
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
	return f, nil
}

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

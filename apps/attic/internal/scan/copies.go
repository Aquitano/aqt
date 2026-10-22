package scan

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/aquitano/aqt/apps/attic/internal/archive"
	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/scratch"
	"github.com/aquitano/aqt/apps/attic/internal/store"
)

func (r *run) copyFailure(ctx context.Context, path string, err error) error {
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
	if errors.Is(err, scratch.ErrChanged) || errors.Is(err, scratch.ErrTooBig) || errors.Is(err, store.ErrNotFound) {
		reason = "changed"
	}
	r.sc.Skip(path, reason, "", err.Error())
	r.log.Warn("content copy failed; the next scan tries again", "path", path, "err", err)
	return nil
}

type archiveCopies struct {
	r       *run
	w       *scratch.Workspace
	ctx     context.Context
	source  string
	copied  string
	failure error
	fatal   error
}

func (c *archiveCopies) open(path string) (archive.Handle, error) {
	if path == c.source {
		return os.Open(c.copied)
	}
	if filepath.Dir(path) != filepath.Dir(c.source) {
		c.failure = fmt.Errorf("archive part is outside its source directory: %s", path)
		return nil, c.failure
	}
	if _, err := disk.Stat(path); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			c.failure = err
		}
		return nil, err
	}
	rel, err := filepath.Rel(c.r.mountRoot, path)
	if err != nil || !filepath.IsLocal(rel) {
		c.failure = fmt.Errorf("archive part is outside its volume: %s", path)
		return nil, c.failure
	}
	rel = "/" + filepath.ToSlash(rel)
	if c.r.rules.SkipContent(rel) {
		c.failure = fmt.Errorf("archive part is excluded by current rules: %s", rel)
		return nil, c.failure
	}
	p, err := c.r.sc.ArchivePart(c.ctx, rel)
	if err != nil {
		c.failure = err
		if !errors.Is(err, store.ErrNotFound) {
			c.fatal = err
		}
		return nil, err
	}
	copied, err := c.w.Copy(c.ctx, path, p.Digest, max(1, p.Size))
	if err != nil {
		c.failure = err
		return nil, err
	}
	f, err := os.Open(copied)
	if err != nil {
		c.failure = scratch.WriteError{Err: err}
		return nil, c.failure
	}
	return &archiveCopy{File: f, path: copied, copies: c}, nil
}

type archiveCopy struct {
	*os.File
	path   string
	copies *archiveCopies
}

func (f *archiveCopy) Close() error {
	if f.File == nil {
		return nil
	}
	err := errors.Join(f.File.Close(), os.Remove(f.path))
	f.File = nil
	if err != nil {
		f.copies.failure = scratch.WriteError{Err: err}
	}
	return err
}

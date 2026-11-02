package scan

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"

	"github.com/aquitano/aqt/apps/attic/internal/metadata"
	"github.com/aquitano/aqt/apps/attic/internal/store"
)

func (r *run) readMetadata(ctx context.Context) error {
	var err error
	r.total, err = r.sc.MetadataTotals(ctx)
	if err != nil || r.total == 0 {
		return err
	}
	r.done, r.seen = 0, map[int64]bool{}
	r.progress(true)
	exiftool := metadata.NewReader(r.o.Config.Metadata.ExifTool)
	defer exiftool.Close()
	var after store.ContentFile
	for {
		batch, err := r.sc.NextMetadata(ctx, after, 64)
		if err != nil || len(batch) == 0 {
			return err
		}
		// A batch is fetched before its results commit, so it can hold two copies.
		read := map[int64]bool{}
		for _, p := range batch {
			if err := ctx.Err(); err != nil {
				return err
			}
			r.count(p.ContentID)
			if r.rulesFor(p.Path).SkipContent(p.Path) || read[p.ContentID] {
				continue
			}
			if max := r.o.Config.Metadata.MaxBytes; max > 0 && p.Size > max {
				r.sc.Skip(p.Path, "too_big", "", "over metadata.max_bytes")
				continue
			}
			ok, err := r.readOneMetadata(ctx, exiftool, p)
			if err != nil {
				return err
			}
			read[p.ContentID] = ok
		}
		after = batch[len(batch)-1]
		if err := r.sc.Commit(ctx); err != nil {
			return err
		}
	}
}

// readOneMetadata holds a file only while ExifTool reads it in place.
// ExifTool reads only the parts that hold tags, so a large video costs a few
// megabytes. A tool failure is a skip for the next scan to retry, never a
// property of the content.
func (r *run) readOneMetadata(ctx context.Context, exiftool *metadata.Reader, p store.ContentFile) (bool, error) {
	r.current = p.Path
	r.progress(false)
	f, err := r.hold(ctx, r.osPath(p.Path), p.Stamp)
	if err != nil {
		return false, r.readFailure(ctx, p.Path, fmt.Errorf("metadata: %w", err))
	}
	result, err := exiftool.Read(ctx, f.Name())
	r.release(f)
	switch {
	case ctx.Err() != nil:
		return false, ctx.Err()
	case errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist):
		return false, err
	case err != nil:
		if gone := r.volumeGone(); gone != nil {
			return false, gone
		}
		r.sc.Skip(p.Path, "metadata_failed", "", err.Error())
		r.log.Warn("metadata tool failed; the next scan tries again", "path", p.Path, "err", err)
		return false, nil
	}
	if result.Status == "failed" {
		r.sc.Skip(p.Path, "metadata_failed", "", result.Detail)
	}
	r.log.Debug("metadata read", "path", p.Path, "status", result.Status, "tags", len(result.Tags))
	return true, r.sc.SetMetadata(ctx, p.ContentID, result)
}

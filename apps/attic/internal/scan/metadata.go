package scan

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"

	"github.com/aquitano/aqt/apps/attic/internal/metadata"
	"github.com/aquitano/aqt/apps/attic/internal/scratch"
	"github.com/aquitano/aqt/apps/attic/internal/store"
)

func (r *run) readMetadata(ctx context.Context) error {
	var err error
	r.total, err = r.sc.MetadataTotals(ctx)
	if err != nil || r.total == 0 {
		return err
	}
	w, err := scratch.New(r.o.Config.Temp, r.log)
	if err != nil {
		return err
	}
	defer func() {
		if err := w.Close(); err != nil {
			r.log.Warn("metadata scratch cleanup will retry later", "err", err)
		}
	}()
	r.done, r.seen = 0, map[int64]bool{}
	r.progress(true)
	var after store.ContentFile
	for {
		batch, err := r.sc.NextMetadata(ctx, after, 64)
		if err != nil || len(batch) == 0 {
			return err
		}
		if err := r.metadataBatch(ctx, w, batch); err != nil {
			return err
		}
		after = batch[len(batch)-1]
		if err := r.sc.Commit(ctx); err != nil {
			return err
		}
	}
}

func (r *run) metadataBatch(ctx context.Context, w *scratch.Workspace, batch []store.ContentFile) error {
	var paths []string
	var pending []store.ContentFile
	var bytes int64
	flush := func() error {
		if err := r.extractMetadata(ctx, pending, paths); err != nil {
			return err
		}
		paths, pending, bytes = nil, nil, 0
		return nil
	}
	queued := map[int64]bool{}
	for _, p := range batch {
		if err := ctx.Err(); err != nil {
			return err
		}
		r.count(p.ContentID)
		if r.rules.SkipContent(p.Path) || queued[p.ContentID] {
			continue
		}
		if max := r.o.Config.Metadata.MaxBytes; max > 0 && p.Size > max {
			r.sc.Skip(p.Path, "too_big", "", "over metadata.max_bytes")
			continue
		}
		// A single larger file runs alone, bounded by metadata.max_bytes.
		if p.Size > (256<<20)-bytes {
			if err := flush(); err != nil {
				return err
			}
		}
		r.current = p.Path
		r.progress(false)
		copied, copyErr := w.Copy(ctx, r.osPath(p.Path), p.Digest, r.o.Config.Metadata.MaxBytes)
		if err := ctx.Err(); err != nil {
			return err
		}
		if gone := r.volumeGone(); gone != nil {
			return gone
		}
		if copyErr != nil {
			if errors.As(copyErr, new(scratch.WriteError)) {
				return copyErr
			}
			reason := "unreadable"
			if errors.Is(copyErr, scratch.ErrChanged) {
				reason = "changed"
			}
			if errors.Is(copyErr, scratch.ErrTooBig) {
				reason = "too_big"
			}
			r.sc.Skip(p.Path, reason, "", fmt.Sprintf("metadata: %v", copyErr))
			r.log.Warn("metadata copy failed", "path", p.Path, "err", copyErr)
			continue
		}
		paths, pending = append(paths, copied), append(pending, p)
		bytes += p.Size
		queued[p.ContentID] = true
	}
	return flush()
}

// A broken batch is retried file by file so one parser failure cannot starve
// the rest of the disk. Tool failures stay skips, not properties of content.
func (r *run) extractMetadata(ctx context.Context, pending []store.ContentFile, paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	results, err := metadata.Read(ctx, r.o.Config.Metadata.ExifTool, paths)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err != nil && len(paths) > 1 {
		for i := range paths {
			if err := r.extractMetadata(ctx, pending[i:i+1], paths[i:i+1]); err != nil {
				return err
			}
		}
		return nil
	}
	for i, p := range pending {
		if err != nil {
			r.sc.Skip(p.Path, "metadata_failed", "", err.Error())
			r.log.Warn("metadata tool failed; the next scan tries again", "path", p.Path, "err", err)
		} else {
			result := results[i]
			if result.Status == "failed" {
				r.sc.Skip(p.Path, "metadata_failed", "", result.Detail)
			}
			if err := r.sc.SetMetadata(ctx, p.ContentID, result); err != nil {
				return err
			}
			r.log.Debug("metadata read", "path", p.Path, "status", result.Status, "tags", len(result.Tags))
		}
		if err := os.Remove(paths[i]); err != nil {
			r.log.Warn("metadata scratch cleanup will retry later", "err", err)
		}
	}
	return nil
}

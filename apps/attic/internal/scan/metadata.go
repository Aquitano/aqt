package scan

import (
	"context"
	"errors"
	"fmt"
	"os"

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
	r.done, r.seen = 0, map[int64]bool{}
	r.progress(true)
	read := map[int64]bool{}
	var after store.PendingMetadata
	for {
		batch, err := r.sc.NextMetadata(ctx, after, 16)
		if err != nil || len(batch) == 0 {
			return err
		}
		if err := r.metadataBatch(ctx, batch, read); err != nil {
			return err
		}
		after = batch[len(batch)-1]
		if err := r.sc.Commit(ctx); err != nil {
			return err
		}
	}
}

func (r *run) metadataBatch(ctx context.Context, batch []store.PendingMetadata, read map[int64]bool) (err error) {
	w, err := scratch.New(r.o.Config.Metadata.Temp, r.log)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, w.Close()) }()
	var paths []string
	var pending []store.PendingMetadata
	var bytes int64
	flush := func() error {
		if len(paths) == 0 {
			return nil
		}
		results, err := metadata.Read(ctx, r.o.Config.Metadata.ExifTool, paths)
		if err != nil {
			return err
		}
		for i, result := range results {
			p := pending[i]
			if result.Status == "failed" {
				r.sc.Skip(p.Path, "metadata_failed", "", result.Detail)
			}
			if err := r.sc.SetMetadata(ctx, p.ContentID, result); err != nil {
				return err
			}
			read[p.ContentID] = true
			r.log.Debug("metadata read", "path", p.Path, "status", result.Status, "tags", len(result.Tags))
			if err := os.Remove(paths[i]); err != nil {
				return err
			}
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
		path := lowerComponents(p.Path)
		excluded, _ := r.rules.Excluded(path, false)
		if excluded || r.rules.NameOnly(path) || read[p.ContentID] || queued[p.ContentID] {
			continue
		}
		if max := r.o.Config.Metadata.MaxBytes; max > 0 && p.Size > max {
			r.sc.Skip(p.Path, "too_big", "", "over metadata.max_bytes")
			continue
		}
		// Flush before another copy exceeds the 256 MiB batch budget. A single
		// larger file is allowed up to metadata.max_bytes and runs on its own.
		if bytes+p.Size > 256<<20 {
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

package server

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"sync"
)

// digestPass lets one digest pass run at a time. A pass asked for while one
// runs makes that one go again, so blobs stored behind its cursor are read.
type digestPass struct {
	mu      sync.Mutex
	running bool
	again   bool
}

// digestBlobs records the BLAKE3 digest of every stored blob that has none.
// It runs when the server starts and after each import. A blob it cannot
// read is skipped and tried again on the next run.
func (s *Server) digestBlobs(ctx context.Context) {
	if s.db == nil {
		return
	}
	s.digests.mu.Lock()
	if s.digests.running {
		s.digests.again = true
		s.digests.mu.Unlock()
		return
	}
	s.digests.running = true
	s.digests.mu.Unlock()
	for {
		s.digestMissing(ctx)
		s.digests.mu.Lock()
		again := s.digests.again && ctx.Err() == nil
		s.digests.again, s.digests.running = false, again
		s.digests.mu.Unlock()
		if !again {
			return
		}
	}
}

func (s *Server) digestMissing(ctx context.Context) {
	after := ""
	for ctx.Err() == nil {
		sums, err := s.db.BlobsWithoutDigest(ctx, after, 200)
		if err != nil {
			slog.Error("listing blobs without a BLAKE3 digest", "error", err)
			return
		}
		if len(sums) == 0 {
			return
		}
		for _, sum := range sums {
			after = sum
			digest, err := s.blobs.BLAKE3(ctx, sum)
			if err == nil {
				err = s.db.SetBlobDigest(ctx, sum, digest)
			}
			if err != nil && !errors.Is(err, fs.ErrNotExist) && ctx.Err() == nil {
				slog.Warn("computing a blob's BLAKE3 digest", "sha256", sum, "error", err)
			}
		}
	}
}

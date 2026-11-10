package server

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"os"

	"lukechampine.com/blake3"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
)

// digestBlobs records the BLAKE3 digest of every stored blob that has none.
// It runs when the server starts and after each import. A blob it cannot
// read is skipped and tried again on the next run.
func (s *Server) digestBlobs(ctx context.Context) {
	if s.db == nil {
		return
	}
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
			digest, err := s.blake3Of(sum)
			if err == nil {
				err = s.db.SetBlobDigest(ctx, sum, digest)
			}
			if err != nil && !errors.Is(err, fs.ErrNotExist) && ctx.Err() == nil {
				slog.Warn("computing a blob's BLAKE3 digest", "sha256", sum, "error", err)
			}
		}
	}
}

func (s *Server) blake3Of(sum string) ([]byte, error) {
	if err := blob.ValidDigest(sum); err != nil {
		return nil, err
	}
	f, err := os.Open(s.blobs.Path(sum))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	h := blake3.New(32, nil)
	if _, err := io.Copy(h, f); err != nil {
		return nil, err
	}
	return h.Sum(nil), nil
}

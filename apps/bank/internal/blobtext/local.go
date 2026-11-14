package blobtext

import (
	"context"
	"fmt"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// Local is an Archive backed by Postgres and the blob store on the same box.
type Local struct {
	Store *store.Store
	Blobs *blob.Store
}

func (l Local) ListBlobs(ctx context.Context, o store.ListBlobsOpts) ([]store.BlobRef, error) {
	return l.Store.ListBlobs(ctx, o)
}

func (l Local) PutBlobText(ctx context.Context, bt store.BlobText) error {
	return l.Store.PutBlobText(ctx, bt)
}

func (l Local) BlobText(ctx context.Context, d content.Digest) (store.BlobText, error) {
	return l.Store.GetBlobText(ctx, d)
}

func (l Local) DeleteBlobText(ctx context.Context, d content.Digest) error {
	return l.Store.DeleteBlobText(ctx, d)
}

func (l Local) ExtractionStats(ctx context.Context) ([]store.ExtractionStat, error) {
	return l.Store.ExtractionStats(ctx)
}

// SetText stores text produced outside any extractor. The server checks the
// digest is one the archive actually carries; against a local store there is
// nobody else to check, and text nothing in the archive points at would be
// reachable by nothing.
func (l Local) SetText(ctx context.Context, bt store.BlobText) error {
	known, err := l.Store.KnownAttachment(ctx, bt.BLAKE3)
	if err != nil {
		return err
	}
	if !known {
		return fmt.Errorf("no attachment with blake3 %s", bt.BLAKE3)
	}
	return l.Store.PutBlobText(ctx, bt)
}

// OpenBlob hands back the store path itself: the bytes are already a local
// file, and copying archive-sized attachments to read them would be waste.
func (l Local) OpenBlob(_ context.Context, d content.Digest) (string, func(), error) {
	return l.Blobs.Path(d), func() {}, nil
}

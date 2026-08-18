package extract

import (
	"context"
	"fmt"

	"github.com/aquitano/aqt-bank/internal/blob"
	"github.com/aquitano/aqt-bank/internal/store"
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

func (l Local) RefreshAttachmentText(ctx context.Context) (int64, error) {
	return l.Store.RefreshAttachmentText(ctx)
}

func (l Local) BlobText(ctx context.Context, sha256 string) (store.BlobText, error) {
	return l.Store.GetBlobText(ctx, sha256)
}

func (l Local) DeleteBlobText(ctx context.Context, sha256 string) error {
	return l.Store.DeleteBlobText(ctx, sha256)
}

func (l Local) ExtractionStats(ctx context.Context) ([]store.ExtractionStat, error) {
	return l.Store.ExtractionStats(ctx)
}

// SetText stores text produced outside any extractor. The server checks the
// digest is one the archive actually carries; against a local store there is
// nobody else to check, and text no message points at would be reachable by
// nothing and swept up by no refresh.
func (l Local) SetText(ctx context.Context, bt store.BlobText) error {
	known, err := l.Store.KnownAttachment(ctx, bt.SHA256)
	if err != nil {
		return err
	}
	if !known {
		return fmt.Errorf("no attachment with sha256 %s", bt.SHA256)
	}
	return l.Store.PutBlobText(ctx, bt)
}

// OpenBlob hands back the store path itself: the bytes are already a local
// file, and copying archive-sized attachments to read them would be waste.
func (l Local) OpenBlob(_ context.Context, sha256 string) (string, func(), error) {
	return l.Blobs.Path(sha256), func() {}, nil
}

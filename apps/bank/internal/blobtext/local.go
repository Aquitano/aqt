package blobtext

import (
	"context"
	"fmt"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/packages/go/extract"
)

// Local is an Archive backed by Postgres and the blob store on the same box.
type Local struct {
	Store *store.Store
	Blobs *blob.Store
	// Known, when set, is asked for a blob's text before the blob is read.
	Known TextSource
}

// TextSource is another store that may already hold the text of the same
// bytes, found by their BLAKE3 digest.
type TextSource interface {
	ReadText(ctx context.Context, blake3 []byte) (text, extractor string, err error)
}

// KnownText is the text Known holds for a blob. A blob without a recorded
// BLAKE3 digest is hashed here, and the digest kept, so a new upload can match
// before the server's digest pass reaches it. Any failure means reading the
// blob as usual.
func (l Local) KnownText(ctx context.Context, sha256 string) (extract.Result, bool) {
	if l.Known == nil {
		return extract.Result{}, false
	}
	digest, err := l.Store.BlobDigest(ctx, sha256)
	if err != nil {
		return extract.Result{}, false
	}
	if digest == nil {
		if digest, err = l.Blobs.BLAKE3(ctx, sha256); err != nil {
			return extract.Result{}, false
		}
		if err := l.Store.SetBlobDigest(ctx, sha256, digest); err != nil {
			return extract.Result{}, false
		}
	}
	text, extractor, err := l.Known.ReadText(ctx, digest)
	if err != nil || text == "" {
		return extract.Result{}, false
	}
	return extract.Result{Text: text, Extractor: "attic: " + extractor, Status: extract.StatusOK}, true
}

func (l Local) ListBlobs(ctx context.Context, o store.ListBlobsOpts) ([]store.BlobRef, error) {
	return l.Store.ListBlobs(ctx, o)
}

func (l Local) PutBlobText(ctx context.Context, bt store.BlobText) error {
	return l.Store.PutBlobText(ctx, bt)
}

func (l Local) RefreshAttachmentText(ctx context.Context, since time.Time) (int64, error) {
	return l.Store.RefreshAttachmentText(ctx, since)
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

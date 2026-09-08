package store

import (
	"context"

	"github.com/google/uuid"
	"github.com/uptrace/bun"
)

type CaptureInput struct {
	Capture Capture
	URL     URLKey
	Blob    RawHTMLBlob
	Version int
}

type CaptureResult struct {
	CaptureID    uuid.UUID
	RawHash      []byte
	Deduplicated bool
}

// InsertCapture is the ingest transaction: url, blob, capture, derivation.
// A blob already on file makes the capture a duplicate; its derivation is
// left alone and any record it already produced just gets a newer last_seen_at.
func (s *Store) InsertCapture(ctx context.Context, in CaptureInput) (CaptureResult, error) {
	res := CaptureResult{CaptureID: in.Capture.ID, RawHash: in.Blob.Hash}
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		if _, err := upsertURL(ctx, tx, in.URL); err != nil {
			return err
		}
		r, err := tx.Tx.ExecContext(ctx, `insert into raw_html_blobs (hash, codec, raw_bytes, stored_bytes, payload)
			values ($1, $2, $3, $4, $5) on conflict (hash) do nothing`,
			in.Blob.Hash, in.Blob.Codec, in.Blob.RawBytes, in.Blob.StoredBytes, in.Blob.Payload)
		if err != nil {
			return err
		}
		inserted, _ := r.RowsAffected()
		res.Deduplicated = inserted == 0
		if _, err := tx.NewInsert().Model(&in.Capture).On("conflict (id) do nothing").Exec(ctx); err != nil {
			return err
		}
		if _, err := tx.NewInsert().Model(&Derivation{RawHash: in.Blob.Hash, Extractor: in.Capture.Extractor,
			ExtractorVersion: in.Version, Status: StatusPending}).
			On("conflict do nothing").Exec(ctx); err != nil {
			return err
		}
		if res.Deduplicated {
			_, err = tx.NewRaw(`update records r set last_seen_at = greatest(r.last_seen_at, ?)
				from derivations d where d.record_id = r.id and d.raw_hash = ?`,
				in.Capture.CapturedAt, in.Blob.Hash).Exec(ctx)
		}
		return err
	})
	if err != nil {
		return CaptureResult{}, err
	}
	return res, nil
}

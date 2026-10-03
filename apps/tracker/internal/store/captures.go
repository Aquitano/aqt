package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"

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

// ErrUnknownPageView means a capture names a page view that is not on file.
// Clients send a page view before its captures, so a retry would fail alike.
var ErrUnknownPageView = errors.New("store: capture names an unknown page view")

// InsertCapture is the ingest transaction: url, blob, capture, derivation.
// A blob already on file makes the capture a duplicate; its derivation is
// left alone and any record it already produced just gets a newer last_seen_at.
func (s *Store) InsertCapture(ctx context.Context, in CaptureInput) (CaptureResult, error) {
	in.Capture.BrowserTitle = strings.ReplaceAll(in.Capture.BrowserTitle, "\x00", "")
	res := CaptureResult{CaptureID: in.Capture.ID, RawHash: in.Blob.Hash}
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		known, err := tx.NewSelect().Model((*PageView)(nil)).Where("id = ?", in.Capture.PageViewID).Exists(ctx)
		if err != nil {
			return err
		}
		if !known {
			return ErrUnknownPageView
		}
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

// LatestCaptureHash is the blob of the most recent capture of the page whose
// normalised URL hashes to urlHash, matched on the page view it belongs to.
func (s *Store) LatestCaptureHash(ctx context.Context, urlHash []byte) ([]byte, error) {
	var hash []byte
	err := s.db.NewRaw(`select c.raw_hash from captures c
		join page_views pv on pv.id = c.page_view_id
		join urls u on u.id = pv.url_id
		where u.url_hash = ?
		order by c.captured_at desc, c.id desc limit 1`, urlHash).Scan(ctx, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return hash, err
}

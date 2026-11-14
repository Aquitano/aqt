package client

import (
	"context"
	"fmt"
	"net/http"

	"github.com/aquitano/aqt/apps/bank/internal/attic/session"
	atticstore "github.com/aquitano/aqt/apps/bank/internal/attic/store"
)

// These are the calls attic scan makes when it writes the catalogue through
// bank serve; package session describes the protocol.

func (c *Client) ResolveVolume(ctx context.Context, r session.VolumeRequest) (atticstore.Volume, error) {
	return postJSON[atticstore.Volume](ctx, c, "/v1/disk/volumes/resolve", nil, r)
}

func (c *Client) StartScan(ctx context.Context, r session.ScanStart) (session.StartedScan, error) {
	return postJSON[session.StartedScan](ctx, c, "/v1/disk/scans", nil, r)
}

func (c *Client) WriteScan(ctx context.Context, id int64, b session.Batch) (session.BatchResult, error) {
	return postJSON[session.BatchResult](ctx, c, scanPath(id, "batches"), nil, b)
}

func (c *Client) KeepScanAlive(ctx context.Context, id int64) error {
	resp, err := c.request(ctx, http.MethodPost, scanPath(id, "keepalive"), nil, nil)
	if err != nil {
		return err
	}
	return resp.Body.Close()
}

func (c *Client) ScanHashWork(ctx context.Context, id int64, r session.WorkRequest) (session.Work[session.HashWork], error) {
	return postJSON[session.Work[session.HashWork]](ctx, c, scanPath(id, "work/hashes"), nil, r)
}

func (c *Client) ScanArchiveWork(ctx context.Context, id int64, r session.WorkRequest) (session.Work[atticstore.PendingArchive], error) {
	return postJSON[session.Work[atticstore.PendingArchive]](ctx, c, scanPath(id, "work/archives"), nil, r)
}

func (c *Client) ScanTextWork(ctx context.Context, id int64, r session.WorkRequest) (session.Work[atticstore.PendingText], error) {
	return postJSON[session.Work[atticstore.PendingText]](ctx, c, scanPath(id, "work/texts"), nil, r)
}

func (c *Client) ScanMetadataWork(ctx context.Context, id int64, r session.WorkRequest) (session.Work[session.MetadataWork], error) {
	return postJSON[session.Work[session.MetadataWork]](ctx, c, scanPath(id, "work/metadata"), nil, r)
}

func (c *Client) CheckScanListing(ctx context.Context, id int64, r session.ListingCheck) (session.ListingNeeded, error) {
	return postJSON[session.ListingNeeded](ctx, c, scanPath(id, "listings/check"), nil, r)
}

func (c *Client) ScanArchivePart(ctx context.Context, id int64, path string) (atticstore.Stamp, error) {
	return postJSON[atticstore.Stamp](ctx, c, scanPath(id, "archive-part"), nil, session.ArchivePartRequest{Path: path})
}

func scanPath(id int64, rest string) string { return fmt.Sprintf("/v1/disk/scans/%d/%s", id, rest) }

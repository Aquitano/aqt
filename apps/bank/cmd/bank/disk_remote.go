package main

import (
	"context"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/disks/ai"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/server"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// remote is the catalogue as verify, dedupe and enrich need it, reached
// through bank's API.
type remote struct{ bank *client.Client }

func (r remote) VerifyFiles(ctx context.Context, volumeID, under string, after store.VerifyFile, limit int) ([]store.VerifyFile, error) {
	return client.Call(ctx, r.bank, server.ListDiskVolumeFiles, server.VolumeFilesInput{ID: volumeID, Under: under,
		AfterPath: after.Path, AfterID: after.ID, PageSize: httpapi.PageSize{Limit: limit}})
}

func (r remote) RecordDedupeMove(ctx context.Context, m store.DedupeMove) error {
	_, err := client.Call(ctx, r.bank, server.RecordDiskDedupeMove, server.DedupeMoveInput{ID: m.EntryID,
		Body: server.DedupeMoveRequest{KeptEntryID: m.KeptEntryID, MovedTo: m.MovedTo}})
	return err
}

func (r remote) AIVolumes(ctx context.Context, o store.AISelection) ([]string, error) {
	return client.Call(ctx, r.bank, server.ListDiskEnrichVolumes, server.EnrichSelectionInput{Body: o})
}

func (r remote) NextAI(ctx context.Context, o store.AISelection, after int64, limit int) ([]store.ContentFile, error) {
	return client.Call(ctx, r.bank, server.ListDiskEnrichCandidates, server.EnrichCandidatesInput{
		Body: server.EnrichCandidatesRequest{Selection: o, After: after, Limit: limit}})
}

func (r remote) ClaimAI(ctx context.Context, contentID int64, key ai.Key, force bool) (*store.AIClaim, error) {
	c, err := client.Call(ctx, r.bank, server.ClaimDiskEnrichment, server.EnrichClaimInput{
		Body: server.EnrichClaimRequest{ContentID: contentID, Key: key, Force: force}})
	if err != nil || !c.Claimed || c.Expires == nil {
		return nil, err
	}
	return &store.AIClaim{Lease: c.Lease, Expires: *c.Expires}, nil
}

func (r remote) RenewAI(ctx context.Context, lease string) (store.AIClaim, error) {
	return client.Call(ctx, r.bank, server.RenewDiskEnrichment, server.LeaseInput{Lease: lease})
}

func (r remote) ReleaseAI(ctx context.Context, lease string) error {
	_, err := client.Call(ctx, r.bank, server.ReleaseDiskEnrichment, server.LeaseInput{Lease: lease})
	return err
}

func (r remote) SaveAI(ctx context.Context, lease string, o store.AIOutcome) error {
	_, err := client.Call(ctx, r.bank, server.SaveDiskEnrichment, server.SaveEnrichmentInput{Lease: lease, Body: o})
	return err
}

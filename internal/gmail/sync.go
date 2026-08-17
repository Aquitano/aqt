package gmail

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync/atomic"

	"golang.org/x/sync/errgroup"

	"github.com/aquitano/aqt-bank/internal/archive"
	"github.com/aquitano/aqt-bank/internal/blob"
	"github.com/aquitano/aqt-bank/internal/eml"
	"github.com/aquitano/aqt-bank/internal/store"
)

type SyncResult struct {
	Mode        string `json:"mode"` // "backfill" or "incremental"
	Inserted    int64  `json:"inserted"`
	Duplicates  int64  `json:"duplicates"`
	Attachments int64  `json:"attachments"`
	Failed      int64  `json:"failed"`
}

type syncState struct {
	HistoryID string `json:"history_id"`
}

const fetchWorkers = 8 // messages.get costs 5 quota units at 250 units/s/user

// Sync pulls new mail. First run (or full=true) walks the whole mailbox;
// afterwards it uses history.list deltas. Both paths are idempotent, so an
// interrupted backfill just resumes on the next run.
func Sync(ctx context.Context, st *store.Store, blobs *blob.Store, dataDir, archiveDir string, full bool) (SyncResult, error) {
	c, err := newClient(ctx, dataDir)
	if err != nil {
		return SyncResult{}, err
	}

	var state syncState
	if !full {
		rawState, err := st.GetSyncState(ctx, "gmail")
		if err != nil {
			return SyncResult{}, err
		}
		if rawState != nil {
			json.Unmarshal(rawState, &state)
		}
	}

	if state.HistoryID == "" {
		return backfill(ctx, c, st, blobs, archiveDir)
	}

	ids, newHistoryID, ok, err := c.listHistory(ctx, state.HistoryID)
	if err != nil {
		return SyncResult{}, err
	}
	if !ok {
		fmt.Fprintln(os.Stderr, "bank: gmail history expired, falling back to a full mailbox walk (dedup makes this safe)")
		return backfill(ctx, c, st, blobs, archiveDir)
	}
	res := SyncResult{Mode: "incremental"}
	if err := fetchAll(ctx, c, st, blobs, archiveDir, ids, &res); err != nil {
		return res, err
	}
	if newHistoryID != "" {
		if err := saveState(ctx, st, newHistoryID); err != nil {
			return res, err
		}
	}
	return res, nil
}

func backfill(ctx context.Context, c *client, st *store.Store, blobs *blob.Store, archiveDir string) (SyncResult, error) {
	res := SyncResult{Mode: "backfill"}
	// Snapshot the history id before listing: anything that arrives during the
	// walk is covered by the next incremental run.
	prof, err := c.profile(ctx)
	if err != nil {
		return res, err
	}
	var ids []string
	if err := c.listMessageIDs(ctx, func(id string) error {
		ids = append(ids, id)
		return nil
	}); err != nil {
		return res, err
	}
	fmt.Fprintf(os.Stderr, "bank: gmail backfill for %s: %d messages\n", prof.EmailAddress, len(ids))
	if err := fetchAll(ctx, c, st, blobs, archiveDir, ids, &res); err != nil {
		return res, err
	}
	return res, saveState(ctx, st, prof.HistoryID)
}

func fetchAll(ctx context.Context, c *client, st *store.Store, blobs *blob.Store, archiveDir string, ids []string, res *SyncResult) error {
	var inserted, duplicates, attachments, failed, done atomic.Int64
	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(fetchWorkers)
	for _, id := range ids {
		g.Go(func() error {
			defer func() {
				if n := done.Add(1); n%500 == 0 {
					fmt.Fprintf(os.Stderr, "bank: gmail %d/%d\n", n, len(ids))
				}
			}()
			exists, err := st.HasMessage(ctx, "gmail", id)
			if err != nil {
				return err
			}
			if exists {
				duplicates.Add(1)
				return nil
			}
			msg, err := c.getRaw(ctx, id)
			if err != nil {
				failed.Add(1)
				fmt.Fprintf(os.Stderr, "bank: gmail message %s: %v\n", id, err)
				return nil
			}
			rawRef, err := archive.Write(archiveDir, "gmail", msg.ID+".eml", msg.Raw)
			if err != nil {
				return err
			}
			ok, atts, err := eml.Ingest(ctx, st, blobs, msg.Raw, eml.IngestOpts{
				Source:     "gmail",
				ExternalID: msg.ID,
				ThreadID:   msg.ThreadID,
				SentAt:     msg.InternalDate,
				RawRef:     rawRef,
			})
			if err != nil {
				failed.Add(1)
				fmt.Fprintf(os.Stderr, "bank: gmail message %s: %v\n", id, err)
				return nil
			}
			if ok {
				inserted.Add(1)
				attachments.Add(int64(atts))
			} else {
				duplicates.Add(1)
			}
			return nil
		})
	}
	err := g.Wait()
	res.Inserted += inserted.Load()
	res.Duplicates += duplicates.Load()
	res.Attachments += attachments.Load()
	res.Failed += failed.Load()
	return err
}

func saveState(ctx context.Context, st *store.Store, historyID string) error {
	raw, err := json.Marshal(syncState{HistoryID: historyID})
	if err != nil {
		return err
	}
	return st.SetSyncState(ctx, "gmail", raw)
}

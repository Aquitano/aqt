package gmail

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"sync"
	"sync/atomic"

	"golang.org/x/sync/errgroup"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/eml"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

type SyncResult struct {
	Mode        string `json:"mode"` // "backfill" or "incremental"
	Inserted    int64  `json:"inserted"`
	Duplicates  int64  `json:"duplicates"`
	Attachments int64  `json:"attachments"`
	// Failed counts messages that could not be fetched or stored for a reason
	// that may pass: an API 5xx, a rate limit, a transient network error. Any
	// of these holds the sync checkpoint back so the next run retries.
	Failed int64 `json:"failed"`
	// Quarantined counts messages Gmail will never serve again — deleted
	// between listing and fetch, or permanently malformed. They are recorded
	// in the sync state so they stop pinning the checkpoint.
	Quarantined    int64    `json:"quarantined"`
	QuarantinedIDs []string `json:"quarantined_ids,omitempty"`
}

type syncState struct {
	HistoryID string `json:"history_id"`
	// Quarantined maps a message id to why it can never be fetched. Without
	// it a single 404 pins the checkpoint forever: the id is gone from the
	// mailbox, so every later run repeats the same backfill or history delta
	// and fails on the same message again.
	Quarantined map[string]string `json:"quarantined,omitempty"`
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
	return runSync(ctx, c, st, blobs, archiveDir, full)
}

// runSync is Sync with the API client already built, which is the seam the
// tests use to drive both modes against a stub Gmail.
func runSync(ctx context.Context, c *client, st *store.Store, blobs *blob.Store, archiveDir string, full bool) (SyncResult, error) {
	state, err := loadState(ctx, st)
	if err != nil {
		return SyncResult{}, err
	}
	if full {
		state.HistoryID = ""
	}

	if state.HistoryID == "" {
		return backfill(ctx, c, st, blobs, archiveDir, state)
	}

	ids, newHistoryID, ok, err := c.listHistory(ctx, state.HistoryID)
	if err != nil {
		return SyncResult{}, err
	}
	if !ok {
		fmt.Fprintln(os.Stderr, "bank: gmail history expired, falling back to a full mailbox walk (dedup makes this safe)")
		state.HistoryID = ""
		return backfill(ctx, c, st, blobs, archiveDir, state)
	}
	res := SyncResult{Mode: "incremental"}
	if err := fetchAll(ctx, c, st, blobs, archiveDir, ids, state, &res); err != nil {
		saveQuarantine(ctx, st, state, &res)
		return res, err
	}
	return res, finish(ctx, st, state, newHistoryID, &res)
}

func backfill(ctx context.Context, c *client, st *store.Store, blobs *blob.Store, archiveDir string, state *syncState) (SyncResult, error) {
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
	if err := fetchAll(ctx, c, st, blobs, archiveDir, ids, state, &res); err != nil {
		saveQuarantine(ctx, st, state, &res)
		return res, err
	}
	return res, finish(ctx, st, state, prof.HistoryID, &res)
}

// finish records the run. Advancing the checkpoint past a message that may yet
// succeed would lose it forever — it never reappears in a later history delta
// — so a retryable failure holds the old history id. Quarantined ids are
// persisted either way: they are the reason the checkpoint may move at all,
// and remembering them keeps the next run from re-fetching known-dead mail.
func finish(ctx context.Context, st *store.Store, state *syncState, newHistoryID string, res *SyncResult) error {
	if res.Failed > 0 {
		if err := saveState(ctx, st, state); err != nil {
			return err
		}
		return fmt.Errorf("%d messages failed; sync state not advanced, next run will retry them", res.Failed)
	}
	if newHistoryID != "" {
		state.HistoryID = newHistoryID
	}
	return saveState(ctx, st, state)
}

// saveQuarantine keeps what an aborted run learned about permanently dead
// ids. An error out of fetchAll skips finish entirely, and forgetting the
// quarantine means re-fetching the same gone messages on every later run. The
// checkpoint is left exactly where it was, so nothing is skipped.
func saveQuarantine(ctx context.Context, st *store.Store, state *syncState, res *SyncResult) {
	if res.Quarantined == 0 {
		return
	}
	if err := saveState(ctx, st, state); err != nil {
		fmt.Fprintf(os.Stderr, "bank: gmail: quarantine not persisted: %v\n", err)
	}
}

func fetchAll(ctx context.Context, c *client, st *store.Store, blobs *blob.Store, archiveDir string, ids []string, state *syncState, res *SyncResult) error {
	var inserted, duplicates, attachments, failed, done atomic.Int64
	quarantined := &quarantine{state: state}
	// The dispatch loop keeps running while workers are already quarantining
	// their 404s, so it must not read the map those writes go into.
	dead := make(map[string]struct{}, len(state.Quarantined))
	for id := range state.Quarantined {
		dead[id] = struct{}{}
	}

	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(fetchWorkers)
	for _, id := range ids {
		if _, gone := dead[id]; gone {
			continue
		}
		g.Go(func() error {
			defer func() {
				if n := done.Add(1); n%500 == 0 {
					fmt.Fprintf(os.Stderr, "bank: gmail %d/%d\n", n, len(ids))
				}
			}()
			// An existing row may come from a run that failed while storing
			// attachments. Let Ingest reconcile it before advancing history.
			msg, err := c.getRaw(ctx, id)
			if err != nil {
				if errors.Is(err, errNotFound) {
					quarantined.add(id, "gone from the mailbox (404)")
					return nil
				}
				failed.Add(1)
				fmt.Fprintf(os.Stderr, "bank: gmail message %s: %v\n", id, err)
				return nil
			}
			rawRef, err := archive.Write(archiveDir, "gmail", msg.ID+".eml", msg.Raw)
			if err != nil {
				return fail.Opf("archive gmail %s: %w", id, err)
			}
			out, err := eml.Ingest(ctx, st, blobs, msg.Raw, eml.IngestOpts{
				Source:     "gmail",
				ExternalID: msg.ID,
				ThreadID:   msg.ThreadID,
				SentAt:     msg.InternalDate,
				RawRef:     rawRef,
			})
			switch {
			case err == nil:
			case fail.IsOp(err):
				return err
			default:
				// The raw bytes are archived; re-fetching will produce the
				// same unparseable message, so retrying forever helps nobody.
				quarantined.add(id, "unparseable: "+err.Error())
				fmt.Fprintf(os.Stderr, "bank: gmail message %s quarantined: %v\n", id, err)
				return nil
			}
			if out.Inserted {
				inserted.Add(1)
			} else {
				duplicates.Add(1)
			}
			attachments.Add(int64(out.Attachments))
			return nil
		})
	}
	err := g.Wait()
	res.Inserted += inserted.Load()
	res.Duplicates += duplicates.Load()
	res.Attachments += attachments.Load()
	res.Failed += failed.Load()
	res.Quarantined += int64(len(quarantined.added))
	res.QuarantinedIDs = append(res.QuarantinedIDs, quarantined.added...)
	sort.Strings(res.QuarantinedIDs)
	return err
}

// quarantine records permanently unavailable message ids into the sync state.
type quarantine struct {
	mu    sync.Mutex
	state *syncState
	added []string
}

func (q *quarantine) add(id, reason string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.state.Quarantined == nil {
		q.state.Quarantined = map[string]string{}
	}
	if _, seen := q.state.Quarantined[id]; seen {
		return
	}
	q.state.Quarantined[id] = reason
	q.added = append(q.added, id)
}

func loadState(ctx context.Context, st *store.Store) (*syncState, error) {
	state := &syncState{}
	raw, err := st.GetSyncState(ctx, "gmail")
	if err != nil {
		return nil, err
	}
	if raw != nil {
		if err := json.Unmarshal(raw, state); err != nil {
			return nil, fmt.Errorf("gmail sync state: %w", err)
		}
	}
	return state, nil
}

func saveState(ctx context.Context, st *store.Store, state *syncState) error {
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return st.SetSyncState(ctx, "gmail", raw)
}

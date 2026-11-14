// Package enrich runs explicitly selected OCR and image-description work.
// Each result commits separately, so cancellation keeps completed work.
package enrich

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/attic/ai"
	"github.com/aquitano/aqt/apps/bank/internal/attic/config"
	"github.com/aquitano/aqt/apps/bank/internal/attic/disk"
	"github.com/aquitano/aqt/apps/bank/internal/attic/scratch"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
)

type Options struct {
	Config    config.Config
	Provider  ai.Provider
	Selection store.AISelection
	// Mounts have already been matched to known catalogue volumes.
	Mounts   map[string]disk.Volume
	Limit    int
	Progress func(store.ContentFile, string)
	Log      *slog.Logger
}

type Summary struct {
	ai.Key
	Attempted int `json:"attempted"`
	Saved     int `json:"saved"`
	Failed    int `json:"failed"`
	Skipped   int `json:"skipped"`
}

func ValidateLimit(provider string, limit int) error {
	if limit < 1 || limit > 1000 {
		return errors.New("limit must be between 1 and 1000")
	}
	if provider == "codex" && limit > 20 {
		return errors.New("Codex enrichment is limited to 20 contents per run")
	}
	return nil
}

// Work is the catalogue's side of a run. *store.Store is one; the machine
// with the disks reaches the same calls through bank serve's API.
type Work interface {
	AIVolumes(ctx context.Context, o store.AISelection) ([]string, error)
	NextAI(ctx context.Context, o store.AISelection, after int64, limit int) ([]store.ContentFile, error)
	ClaimAI(ctx context.Context, contentID int64, key ai.Key, force bool) (*store.AIClaim, error)
	RenewAI(ctx context.Context, lease string) (store.AIClaim, error)
	ReleaseAI(ctx context.Context, lease string) error
	SaveAI(ctx context.Context, lease string, o store.AIOutcome) error
}

func Run(ctx context.Context, st Work, o Options) (Summary, error) {
	var summary Summary
	if o.Provider == nil {
		return summary, errors.New("enrichment needs a provider")
	}
	summary.Key = o.Provider.Key()
	if err := ValidateLimit(summary.Provider, o.Limit); err != nil {
		return summary, err
	}
	if err := o.Config.AI.Validate(); err != nil {
		return summary, err
	}
	if err := o.Config.NormalizeTemp(); err != nil {
		return summary, err
	}
	if len(o.Mounts) == 0 {
		return summary, errors.New("no selected catalogue volumes are online")
	}
	log := o.Log
	if log == nil {
		log = slog.Default()
	}
	temp := o.Config.Temp
	selection := o.Selection
	selection.Key, selection.Extensions = o.Provider.Key(), o.Provider.Extensions()
	selection.Volumes = nil
	rules := map[string]config.Rules{}
	for id, m := range o.Mounts {
		selection.Volumes = append(selection.Volumes, id)
		rules[id] = o.Config.Rules(id, m.Label)
	}
	slices.Sort(selection.Volumes)
	selected, err := st.AIVolumes(ctx, selection)
	if err != nil {
		return summary, err
	}
	if len(selected) == 0 {
		return summary, nil
	}
	for _, id := range selected {
		if err := scratch.CheckVolume(o.Mounts[id].Fingerprint, temp); err != nil {
			return summary, err
		}
	}
	w, err := scratch.New(temp, log)
	if err != nil {
		return summary, err
	}
	defer func() {
		if err := w.Close(); err != nil {
			log.Warn("enrichment scratch cleanup will retry later", "err", err)
		}
	}()
	report := func(p store.ContentFile, status string) {
		if o.Progress != nil {
			o.Progress(p, status)
		}
	}
	seen := map[int64]bool{}
	// New work always precedes retries: a permanent failure must not take the
	// first slot forever on every bounded run.
	for _, retry := range []bool{false, true} {
		if retry && selection.Force {
			break
		}
		selection.Retry = retry
		var after int64
		for summary.Attempted < o.Limit {
			batch, err := st.NextAI(ctx, selection, after, 64)
			if err != nil {
				return summary, err
			}
			if len(batch) == 0 {
				break
			}
			for _, p := range batch {
				after = p.ID
				if err := ctx.Err(); err != nil {
					return summary, err
				}
				if seen[p.ContentID] {
					continue
				}
				if rules[p.VolumeID].SkipContent(p.Path) {
					summary.Skipped++
					report(p, "excluded by current rules")
					continue
				}
				if max := o.Config.AI.MaxBytes; max > 0 && p.Size > max {
					seen[p.ContentID] = true
					summary.Skipped++
					report(p, "over ai.max_bytes")
					continue
				}
				claim, err := st.ClaimAI(ctx, p.ContentID, summary.Key, selection.Force)
				if err != nil {
					return summary, err
				}
				if claim == nil {
					continue
				}
				attempted, status, err := readOne(ctx, w, st, o, p, claim.Lease, log)
				if attempted {
					summary.Attempted++
					seen[p.ContentID] = true
				}
				if errors.Is(err, ai.ErrInput) {
					// Validation rejected these bytes, so another copy cannot help.
					seen[p.ContentID] = true
					status, err = err.Error(), nil
				}
				if err != nil {
					return summary, err
				}
				if attempted {
					if status == "saved" {
						summary.Saved++
					} else {
						summary.Failed++
					}
				} else {
					summary.Skipped++
				}
				report(p, status)
				if summary.Attempted >= o.Limit {
					break
				}
			}
		}
	}
	return summary, nil
}

// readOne reads one content under lease. It saves the outcome, which ends the
// lease, or releases the lease without one.
func readOne(ctx context.Context, w *scratch.Workspace, st Work, o Options, p store.ContentFile, lease string, log *slog.Logger) (bool, string, error) {
	saved := false
	defer func() {
		if !saved {
			release, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			defer cancel()
			if err := st.ReleaseAI(release, lease); err != nil {
				log.Warn("enrichment claim stays until its lease runs out", "err", err)
			}
		}
	}()
	mount := o.Mounts[p.VolumeID]
	if runtime.GOOS == "windows" {
		current, _, err := disk.Locate(mount.Root)
		if err != nil {
			return false, "", err
		}
		v := store.Volume{FS: mount.FS, Serial: mount.Serial, PartitionID: mount.PartitionID, DeviceSerial: mount.DeviceSerial}
		if !v.Holds(current.Fingerprint) {
			return false, "", errors.New("source volume changed during enrichment")
		}
	}
	rel := filepath.FromSlash(strings.TrimPrefix(p.Path, "/"))
	if !filepath.IsLocal(rel) {
		return false, "", fmt.Errorf("non-local catalogue path %q", p.Path)
	}
	copied, err := w.Copy(ctx, filepath.Join(mount.Root, rel), p.Digest, o.Config.AI.MaxBytes)
	if ctx.Err() != nil {
		return false, "", ctx.Err()
	}
	if err != nil {
		if errors.As(err, new(scratch.WriteError)) {
			return false, "", err
		}
		return false, err.Error(), nil
	}
	defer func() {
		if err := os.Remove(copied); err != nil {
			log.Warn("enrichment copy cleanup will retry later", "err", err)
		}
	}()
	timeout, cancel := context.WithTimeout(ctx, time.Duration(o.Config.AI.TimeoutSeconds)*time.Second)
	defer cancel()
	stopRenewing := renew(timeout, st, lease, log)
	start := time.Now()
	result, failure := o.Provider.Read(timeout, copied)
	stopRenewing()
	if failure == nil && timeout.Err() != nil {
		failure = timeout.Err()
	}
	if ctx.Err() != nil {
		return true, "", ctx.Err()
	}
	if errors.Is(failure, ai.ErrUnavailable) {
		return true, "", failure
	}
	if errors.Is(failure, ai.ErrInput) {
		return false, "", failure
	}
	outcome := store.AIOutcome{Result: result, ElapsedMS: time.Since(start).Milliseconds()}
	if failure != nil {
		outcome.Failure = failure.Error()
	}
	saved = true
	switch err := st.SaveAI(ctx, lease, outcome); {
	case errors.Is(err, store.ErrClaimLost):
		return true, "not saved: the claim ran out and another worker took the work", nil
	case err != nil:
		return true, "", err
	case failure != nil:
		return true, "failed: " + failure.Error(), nil
	}
	return true, "saved", nil
}

// renew keeps lease current while a provider runs, until the returned stop is
// called. A lease that cannot be renewed is left to run out: the result is
// then refused when it is saved.
func renew(ctx context.Context, st Work, lease string, log *slog.Logger) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		tick := time.NewTicker(store.AILease / 4)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				if _, err := st.RenewAI(ctx, lease); err != nil && ctx.Err() == nil {
					log.Warn("enrichment claim not renewed", "err", err)
					if errors.Is(err, store.ErrClaimLost) {
						return
					}
				}
			}
		}
	}()
	return func() {
		cancel()
		<-done
	}
}

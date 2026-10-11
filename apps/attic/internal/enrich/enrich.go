// Package enrich runs explicitly selected OCR and image-description work.
// Each result commits separately, so cancellation keeps completed work.
package enrich

import (
	"cmp"
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

	"github.com/aquitano/aqt/apps/attic/internal/ai"
	"github.com/aquitano/aqt/apps/attic/internal/config"
	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/scratch"
	"github.com/aquitano/aqt/apps/attic/internal/store"
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

func Run(ctx context.Context, st *store.Store, o Options) (Summary, error) {
	var summary Summary
	if o.Provider == nil {
		return summary, errors.New("enrichment needs a provider")
	}
	summary.Key = o.Provider.Key()
	if o.Limit < 1 || o.Limit > 1000 {
		return summary, errors.New("limit must be between 1 and 1000")
	}
	if summary.Provider == "codex" && o.Limit > 20 {
		return summary, errors.New("Codex enrichment is limited to 20 contents per run")
	}
	if o.Config.AI.TimeoutSeconds <= 0 || o.Config.AI.MaxBytes < 0 {
		return summary, errors.New("invalid enrichment limits")
	}
	if len(o.Mounts) == 0 {
		return summary, errors.New("no selected catalogue volumes are online")
	}
	log := o.Log
	if log == nil {
		log = slog.Default()
	}
	temp := cmp.Or(o.Config.AI.Temp, o.Config.Archives.Temp, os.TempDir())
	selection := o.Selection
	selection.Key, selection.Extensions = o.Provider.Key(), o.Provider.Extensions()
	selection.Volumes = nil
	rules := map[string]config.Rules{}
	for id, m := range o.Mounts {
		if err := scratch.CheckVolume(m.Fingerprint, temp); err != nil {
			return summary, err
		}
		selection.Volumes = append(selection.Volumes, id)
		rules[id] = o.Config.Rules(id, m.Label)
	}
	slices.Sort(selection.Volumes)
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
	var after int64
	for summary.Attempted < o.Limit {
		batch, err := st.NextAI(ctx, selection, after, 64)
		if err != nil || len(batch) == 0 {
			return summary, err
		}
		for _, p := range batch {
			after = p.ID
			if err := ctx.Err(); err != nil {
				return summary, err
			}
			if seen[p.ContentID] {
				continue
			}
			r := rules[p.VolumeID]
			parts := strings.Split(strings.ToLower(strings.TrimPrefix(p.Path, "/")), "/")
			excluded, _ := r.Excluded(parts, false)
			for i := 1; i < len(parts) && !excluded; i++ {
				excluded, _ = r.Excluded(parts[:i], true)
			}
			if excluded || r.NameOnly(parts) {
				summary.Skipped++
				report(p, "excluded by current rules")
				continue
			}
			if max := o.Config.AI.MaxBytes; max > 0 && p.Size > max {
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
			attempted, status, err := readOne(ctx, w, o, p, claim, log)
			if err != nil {
				return summary, err
			}
			if attempted {
				seen[p.ContentID] = true
				summary.Attempted++
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
	return summary, nil
}

func readOne(ctx context.Context, w *scratch.Workspace, o Options, p store.ContentFile, claim *store.AIClaim, log *slog.Logger) (bool, string, error) {
	defer claim.Close()
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
	start := time.Now()
	result, failure := o.Provider.Read(timeout, copied)
	if failure == nil && timeout.Err() != nil {
		failure = timeout.Err()
	}
	if ctx.Err() != nil {
		return true, "", ctx.Err()
	}
	if err := claim.Save(ctx, result, failure, time.Since(start)); err != nil {
		return true, "", err
	}
	if failure != nil {
		return true, "failed: " + failure.Error(), nil
	}
	return true, "saved", nil
}

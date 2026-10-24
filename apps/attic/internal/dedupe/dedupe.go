// Package dedupe sets aside extra copies of a content: it moves them into a
// quarantine folder on their own disk, never deletes them, and only after the
// kept copy and the extra copy have both been hashed again just now.
package dedupe

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/apps/attic/internal/view"
)

// Quarantine is the folder at each volume's root that holds set-aside
// copies. Scans exclude it, so its files never count as copies again.
const Quarantine = ".attic-quarantine"

type Recorder interface {
	RecordDedupeMove(context.Context, store.DedupeMove) error
}

type Move struct {
	Ref         string `json:"ref"`
	EntryID     int64  `json:"entry_id"`
	KeptEntryID int64  `json:"kept_entry_id"`
	From        string `json:"from"`
	To          string `json:"to"`
	Size        int64  `json:"size"`
}

type Skip struct {
	Ref     string `json:"ref"`
	EntryID int64  `json:"entry_id"`
	Path    string `json:"path"`
	Reason  string `json:"reason"`
}

type Result struct {
	Moved   []Move `json:"moved"`
	Skipped []Skip `json:"skipped"`
	Bytes   int64  `json:"bytes"`
}

// Apply moves each group's extra copies into
// <volume root>/.attic-quarantine/<run>/<original path>. roots maps the IDs of
// attached volumes to where they are mounted. A group whose kept copies are
// all detached or no longer match their digest moves nothing.
func Apply(ctx context.Context, rec Recorder, groups []store.DedupeGroup, roots map[string]string, run string) (Result, error) {
	res := Result{Moved: []Move{}, Skipped: []Skip{}}
	for _, g := range groups {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		kept, reason := verifiedCopy(ctx, g.Kept, g.Digest, roots)
		for _, extra := range g.Extra {
			skip := func(reason string) {
				res.Skipped = append(res.Skipped, Skip{Ref: g.Ref, EntryID: extra.ID, Path: view.DisplayPath(extra.VolumeID, extra.Volume, extra.Path, roots), Reason: reason})
			}
			if kept == nil {
				skip(reason)
				continue
			}
			root, online := roots[extra.VolumeID]
			if !online {
				skip("its disk is not attached")
				continue
			}
			rel, err := local(extra.Path)
			if err != nil {
				skip(err.Error())
				continue
			}
			if digest, _, err := disk.HashOrdinary(ctx, root, rel); err != nil {
				skip("could not be read again: " + err.Error())
				continue
			} else if digest != g.Digest {
				skip("changed since its scan")
				continue
			}
			to := filepath.Join(root, Quarantine, run, rel)
			if err := move(filepath.Join(root, rel), to); err != nil {
				skip(err.Error())
				continue
			}
			if err := rec.RecordDedupeMove(ctx, store.DedupeMove{EntryID: extra.ID, KeptEntryID: kept.ID, ContentID: g.ContentID, MovedTo: to}); err != nil {
				// An unrecorded move would leave the catalogue unable to say
				// where the copy went, so the copy goes back.
				return res, errors.Join(fmt.Errorf("record the move of %s: %w", extra.Path, err), os.Rename(to, filepath.Join(root, rel)))
			}
			res.Moved = append(res.Moved, Move{Ref: g.Ref, EntryID: extra.ID, KeptEntryID: kept.ID, From: filepath.Join(root, rel), To: to, Size: extra.Size})
			res.Bytes += extra.Size
		}
	}
	return res, nil
}

// verifiedCopy is the first kept copy on an attached disk whose bytes still
// hash to the content's digest.
func verifiedCopy(ctx context.Context, kept []store.Hit, digest disk.Digest, roots map[string]string) (*store.Hit, string) {
	reason := "no kept copy is on an attached disk"
	for i, h := range kept {
		root, online := roots[h.VolumeID]
		if !online {
			continue
		}
		rel, err := local(h.Path)
		if err != nil {
			continue
		}
		got, _, err := disk.HashOrdinary(ctx, root, rel)
		if err == nil && got == digest {
			return &kept[i], ""
		}
		reason = "no attached kept copy still matches its digest"
	}
	return nil, reason
}

func local(catalogued string) (string, error) {
	rel := filepath.FromSlash(strings.TrimPrefix(catalogued, "/"))
	if !filepath.IsLocal(rel) {
		return "", fmt.Errorf("non-local catalogue path %q", catalogued)
	}
	return rel, nil
}

// move renames within one volume and refuses to replace anything, because
// os.Rename overwrites an existing file on Windows.
func move(from, to string) error {
	if _, err := os.Lstat(to); err == nil {
		return fmt.Errorf("%s already exists", to)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o700); err != nil {
		return err
	}
	return os.Rename(from, to)
}

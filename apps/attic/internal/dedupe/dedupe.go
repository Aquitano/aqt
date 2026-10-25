// Package dedupe sets aside extra copies of a content: it moves them into a
// quarantine folder on their own disk, never deletes them, and only after the
// kept copy and the extra copy have both been hashed again just now.
package dedupe

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
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
// all detached or no longer match their digest moves nothing. Neither does a
// disk that several known volumes claim, such as two clones whose USB bridge
// reports no serial: a kept and an extra entry could name the same file.
func Apply(ctx context.Context, rec Recorder, groups []store.DedupeGroup, roots map[string]string, run string) (Result, error) {
	res := Result{Moved: []Move{}, Skipped: []Skip{}}
	attached, shared := unambiguous(roots)
	for _, g := range groups {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		skip := func(extra store.Hit, reason string) {
			res.Skipped = append(res.Skipped, Skip{Ref: g.Ref, EntryID: extra.ID, Path: view.DisplayPath(extra.VolumeID, extra.Volume, extra.Path, roots), Reason: reason})
		}
		var movable []store.Hit
		for _, extra := range g.Extra {
			switch _, online := attached[extra.VolumeID]; {
			case shared[extra.VolumeID]:
				skip(extra, "its disk fits more than one known volume")
			case !online:
				skip(extra, "its disk is not attached")
			default:
				movable = append(movable, extra)
			}
		}
		if len(movable) == 0 {
			continue
		}
		kept, reason := verifiedCopy(ctx, g.Kept, g.Digest, attached)
		for _, extra := range movable {
			if kept == nil {
				skip(extra, reason)
				continue
			}
			m, reason, err := setAside(ctx, rec, g, kept.ID, extra, attached[extra.VolumeID], run)
			if err != nil {
				return res, err
			}
			if reason != "" {
				skip(extra, reason)
				continue
			}
			res.Moved = append(res.Moved, m)
			res.Bytes += m.Size
		}
	}
	return res, nil
}

// unambiguous keeps the roots that exactly one volume claims and returns the
// IDs of the volumes that share one.
func unambiguous(roots map[string]string) (map[string]string, map[string]bool) {
	claims := map[string]int{}
	for _, root := range roots {
		claims[root]++
	}
	attached, shared := map[string]string{}, map[string]bool{}
	for id, root := range roots {
		if claims[root] == 1 {
			attached[id] = root
		} else {
			shared[id] = true
		}
	}
	return attached, shared
}

// setAside moves one extra copy into the quarantine. A reason means the copy
// stayed in place; an error means the run must stop, and says where the copy
// is when it could not go back.
func setAside(ctx context.Context, rec Recorder, g store.DedupeGroup, keptID int64, extra store.Hit, root, run string) (Move, string, error) {
	rel, err := local(extra.Path)
	if err != nil {
		return Move{}, err.Error(), nil
	}
	digest, hashed, err := disk.HashOrdinaryInfo(ctx, root, rel)
	if err != nil {
		return Move{}, "could not be read again: " + err.Error(), nil
	}
	if digest != g.Digest {
		return Move{}, "changed since its scan", nil
	}
	toRel := filepath.Join(Quarantine, run, rel)
	from, to := filepath.Join(root, rel), filepath.Join(root, toRel)
	if err := mkdirs(root, filepath.Dir(toRel)); err != nil {
		return Move{}, err.Error(), nil
	}
	if err := disk.Move(from, to); err != nil {
		return Move{}, err.Error(), nil
	}
	// The move resolves the path again, so an editor saving over the file or a
	// folder swapped for a junction meanwhile would move other bytes. Only the
	// hashed file, unwritten since, stays in the quarantine.
	if !unchanged(root, toRel, hashed) {
		if err := disk.Move(to, from); err != nil {
			return Move{}, "", fmt.Errorf("%s changed while it was set aside and stays at %s: %w", from, to, err)
		}
		return Move{}, "changed while it was being set aside", nil
	}
	if err := rec.RecordDedupeMove(ctx, store.DedupeMove{EntryID: extra.ID, KeptEntryID: keptID, ContentID: g.ContentID, MovedTo: to}); err != nil {
		// An unrecorded move would leave the catalogue unable to say where the
		// copy went, so the copy goes back unless its path was taken meanwhile.
		err = fmt.Errorf("record the move of %s: %w", extra.Path, err)
		if back := disk.Move(to, from); back != nil {
			return Move{}, "", errors.Join(err, fmt.Errorf("the copy stays at %s: %w", to, back))
		}
		return Move{}, "", err
	}
	return Move{Ref: g.Ref, EntryID: extra.ID, KeptEntryID: keptID, From: from, To: to, Size: extra.Size}, "", nil
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

// unchanged reports whether root/rel, reached without following links, is
// the file that was hashed and has not been written since.
func unchanged(root, rel string, hashed fs.FileInfo) bool {
	f, err := disk.OpenOrdinary(root, rel)
	if err != nil {
		return false
	}
	defer f.Close()
	now, err := f.Stat()
	return err == nil && os.SameFile(now, hashed) && now.Size() == hashed.Size() && now.ModTime().Equal(hashed.ModTime())
}

// mkdirs creates root/rel one folder at a time and refuses one that is a link
// or junction, so the quarantine cannot lead off the disk's own folders.
func mkdirs(root, rel string) error {
	dir := root
	for part := range strings.SplitSeq(rel, string(filepath.Separator)) {
		dir = filepath.Join(dir, part)
		if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
			return err
		}
		info, err := os.Lstat(dir)
		if err != nil {
			return err
		}
		if info.Mode().Type() != fs.ModeDir {
			return fmt.Errorf("%s is not an ordinary folder", dir)
		}
	}
	return nil
}

func local(catalogued string) (string, error) {
	rel := filepath.FromSlash(strings.TrimPrefix(catalogued, "/"))
	if !filepath.IsLocal(rel) {
		return "", fmt.Errorf("non-local catalogue path %q", catalogued)
	}
	return rel, nil
}

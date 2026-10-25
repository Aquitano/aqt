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
	"runtime"
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
// <volume root>/.attic-quarantine/<run>/<original path>. mounts maps the IDs
// of attached volumes to their mounts. A group whose kept copies are all
// detached or no longer match their digest moves nothing. Neither does a disk
// that several known volumes claim, such as two clones whose USB bridge
// reports no serial: a kept and an extra entry could name the same file.
func Apply(ctx context.Context, rec Recorder, groups []store.DedupeGroup, mounts map[string]disk.Volume, run string) (Result, error) {
	res := Result{Moved: []Move{}, Skipped: []Skip{}}
	roots := view.Roots(mounts)
	attached, shared := unambiguous(mounts)
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
			if err := ctx.Err(); err != nil {
				return res, err
			}
			if kept != nil && !kept.intact() {
				kept, reason = nil, keptChanged
			}
			if kept == nil {
				skip(extra, reason)
				continue
			}
			m, reason, err := setAside(ctx, rec, g, kept, extra, attached[extra.VolumeID], run)
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
	return res, ctx.Err()
}

// unambiguous keeps the mounts that exactly one volume claims and returns the
// IDs of the volumes that share one.
func unambiguous(mounts map[string]disk.Volume) (map[string]disk.Volume, map[string]bool) {
	claims := map[string]int{}
	for _, m := range mounts {
		claims[m.Root]++
	}
	attached, shared := map[string]disk.Volume{}, map[string]bool{}
	for id, m := range mounts {
		if claims[m.Root] == 1 {
			attached[id] = m
		} else {
			shared[id] = true
		}
	}
	return attached, shared
}

const keptChanged = "the kept copy changed or went away during the run"

// setAside moves one extra copy into the quarantine. A reason means the copy
// stayed in place; an error means the run must stop, and says where the copy
// is when it could not go back.
func setAside(ctx context.Context, rec Recorder, g store.DedupeGroup, kept *keptCopy, extra store.Hit, mount disk.Volume, run string) (Move, string, error) {
	rel, err := local(extra.Path)
	if err != nil {
		return Move{}, err.Error(), nil
	}
	if !here(mount) {
		return Move{}, "its disk changed since the run started", nil
	}
	root := mount.Root
	digest, hashed, err := disk.HashOrdinaryInfo(ctx, root, rel)
	if ctx.Err() != nil {
		return Move{}, "", ctx.Err()
	}
	if err != nil {
		return Move{}, "could not be read again: " + err.Error(), nil
	}
	if digest != g.Digest {
		return Move{}, "changed since its scan", nil
	}
	// Hashing a large copy takes a while, so the kept copy is checked again
	// right before the move.
	if !kept.intact() {
		return Move{}, keptChanged, nil
	}
	toRel := filepath.Join(Quarantine, run, rel)
	from, to := filepath.Join(root, rel), filepath.Join(root, toRel)
	if err := folders(root, filepath.Dir(toRel), true); err != nil {
		return Move{}, err.Error(), nil
	}
	if err := disk.Move(from, to); err != nil {
		return Move{}, err.Error(), nil
	}
	// The move resolves the path again, so an editor saving over the file or a
	// folder swapped for a junction meanwhile would move other bytes. Only the
	// hashed bytes, unwritten since, stay in the quarantine.
	if !stillHashed(ctx, root, toRel, hashed, digest, mount.StableIDs) {
		if err := putBack(root, rel, to); err != nil {
			return Move{}, "", fmt.Errorf("%s changed while it was set aside and stays at %s: %w", from, to, err)
		}
		return Move{}, "changed while it was being set aside", nil
	}
	if err := rec.RecordDedupeMove(ctx, store.DedupeMove{EntryID: extra.ID, KeptEntryID: kept.hit.ID, ContentID: g.ContentID, MovedTo: to}); err != nil {
		// An unrecorded move would leave the catalogue unable to say where the
		// copy went, so the copy goes back unless its path was taken meanwhile.
		err = fmt.Errorf("record the move of %s: %w", extra.Path, err)
		if back := putBack(root, rel, to); back != nil {
			return Move{}, "", errors.Join(err, fmt.Errorf("the copy stays at %s: %w", to, back))
		}
		return Move{}, "", err
	}
	return Move{Ref: g.Ref, EntryID: extra.ID, KeptEntryID: kept.hit.ID, From: from, To: to, Size: extra.Size}, "", nil
}

// putBack returns a set-aside copy to root/rel. It refuses a path that is
// taken, or whose folders now lead through a link or junction.
func putBack(root, rel, to string) error {
	if err := folders(root, filepath.Dir(rel), false); err != nil {
		return err
	}
	return disk.Move(to, filepath.Join(root, rel))
}

// keptCopy is a kept copy as it was when it hashed to the content's digest.
type keptCopy struct {
	hit   store.Hit
	mount disk.Volume
	rel   string
	info  fs.FileInfo
}

// intact reports whether the kept copy is still the same file on the same
// disk, unwritten since it was hashed.
func (k *keptCopy) intact() bool {
	if !here(k.mount) {
		return false
	}
	now, err := statOrdinary(k.mount.Root, k.rel)
	return err == nil && os.SameFile(now, k.info) && unwritten(k.info, now)
}

// verifiedCopy is the first kept copy on an attached disk whose bytes still
// hash to the content's digest.
func verifiedCopy(ctx context.Context, kept []store.Hit, digest disk.Digest, mounts map[string]disk.Volume) (*keptCopy, string) {
	reason := "no kept copy is on an attached disk"
	for _, h := range kept {
		m, online := mounts[h.VolumeID]
		if !online || !here(m) {
			continue
		}
		rel, err := local(h.Path)
		if err != nil {
			continue
		}
		got, info, err := disk.HashOrdinaryInfo(ctx, m.Root, rel)
		if err == nil && got == digest {
			return &keptCopy{hit: h, mount: m, rel: rel, info: info}, ""
		}
		reason = "no attached kept copy still matches its digest"
	}
	return nil, reason
}

// here reports whether the disk at m.Root is still the one the run started
// with. Locating a volume needs Windows; elsewhere the check passes.
func here(m disk.Volume) bool {
	if runtime.GOOS != "windows" {
		return true
	}
	current, _, err := disk.Locate(m.Root)
	return err == nil && current.Fingerprint == m.Fingerprint
}

// stillHashed reports whether root/rel, reached without following links,
// holds the hashed bytes, unwritten since. With stable IDs it must be the
// same file. FAT and exFAT give a moved file a new ID, so there another file
// is hashed again and must stay unwritten through that read.
func stillHashed(ctx context.Context, root, rel string, hashed fs.FileInfo, digest disk.Digest, stableIDs bool) bool {
	now, err := statOrdinary(root, rel)
	if err != nil || !unwritten(hashed, now) {
		return false
	}
	if os.SameFile(now, hashed) {
		return true
	}
	if stableIDs {
		return false
	}
	got, _, err := disk.HashOrdinary(ctx, root, rel)
	if err != nil || got != digest {
		return false
	}
	after, err := statOrdinary(root, rel)
	return err == nil && os.SameFile(after, now) && unwritten(hashed, after)
}

func statOrdinary(root, rel string) (fs.FileInfo, error) {
	f, err := disk.OpenOrdinary(root, rel)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return f.Stat()
}

func unwritten(was, now fs.FileInfo) bool {
	return now.Size() == was.Size() && now.ModTime().Equal(was.ModTime())
}

// folders checks that each folder of rel below root is an ordinary folder,
// not a link or junction that would send a move elsewhere. create makes the
// missing ones first.
func folders(root, rel string, create bool) error {
	if rel == "." {
		return nil
	}
	dir := root
	for part := range strings.SplitSeq(rel, string(filepath.Separator)) {
		dir = filepath.Join(dir, part)
		if create {
			if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
				return err
			}
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

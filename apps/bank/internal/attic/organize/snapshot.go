package organize

import (
	"context"
	"errors"
	"fmt"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/attic/disk"
)

// Item is one file or folder of a moved object. Path is relative to the
// object, "." for the object itself. On NTFS and ReFS a rename keeps the file
// record, so the same FileID also carries the streams, times, attributes,
// owner and permissions the file had, and an unchanged change time shows that
// none of them was rewritten.
type Item struct {
	Path     string       `json:"path"`
	Dir      bool         `json:"dir,omitempty"`
	Size     int64        `json:"size,omitempty"`
	Modified time.Time    `json:"modified,omitzero"`
	Changed  time.Time    `json:"changed,omitzero"`
	FileID   uint64       `json:"file_id,omitempty"`
	Digest   *disk.Digest `json:"blake3,omitempty"`
}

// snapshot lists the object at rel below root and everything inside it
// without following links, the object itself first. It refuses links,
// junctions and cloud placeholders anywhere in the object. hash also reads
// every file's digest.
func snapshot(ctx context.Context, root, rel string, hash bool) ([]Item, error) {
	native := filepath.FromSlash(rel)
	if err := disk.Folders(root, filepath.Dir(native), false); err != nil {
		return nil, err
	}
	top, err := disk.Lstat(filepath.Join(root, native))
	if err != nil {
		return nil, err
	}
	var items []Item
	err = walk(ctx, root, rel, ".", top, hash, &items)
	return items, err
}

func walk(ctx context.Context, root, rel, inside string, e disk.Entry, hash bool, items *[]Item) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	at := path.Join(rel, inside)
	if e.Link || e.Remote {
		return fmt.Errorf("%s is a link, junction or cloud placeholder", at)
	}
	it := Item{Path: inside, Dir: e.Dir, FileID: e.FileID}
	if !e.Dir {
		it.Size, it.Modified, it.Changed = e.Size, e.Modified, e.Changed
		if hash {
			d, info, err := disk.HashOrdinaryInfo(ctx, root, filepath.FromSlash(at))
			if err != nil {
				return err
			}
			after, err := disk.Lstat(filepath.Join(root, filepath.FromSlash(at)))
			if err != nil {
				return err
			}
			if info.Size() != e.Size || !info.ModTime().Equal(e.Modified) || after.Size != e.Size || !after.Modified.Equal(e.Modified) {
				return fmt.Errorf("%s changed while it was read", at)
			}
			it.Digest = &d
		}
		*items = append(*items, it)
		return nil
	}
	*items = append(*items, it)
	children, err := disk.List(filepath.Join(root, filepath.FromSlash(at)))
	if err != nil {
		return err
	}
	slices.SortFunc(children, func(a, b disk.Entry) int { return strings.Compare(a.Name, b.Name) })
	for _, c := range children {
		if err := walk(ctx, root, rel, path.Join(inside, c.Name), c, hash, items); err != nil {
			return err
		}
	}
	return nil
}

// compare checks that the object at rel, listed as now, is exactly the
// baseline: every file and folder once, nothing added. Without rehash every
// file must be the same file system object, unwritten since; with rehash its
// bytes must match instead. A rename updates the moved object's own change
// time, so that one is compared with top instead, and not at all when top is
// zero. Folders count by their place in the tree: their times move whenever a
// program adds and removes a scratch file inside.
func compare(rel string, base, now []Item, rehash bool, top time.Time) error {
	got := make(map[string]Item, len(now))
	for _, it := range now {
		got[it.Path] = it
	}
	var problems []string
	for _, want := range base {
		have, ok := got[want.Path]
		delete(got, want.Path)
		at := path.Join(rel, want.Path)
		changed := want.Changed
		if want.Path == "." {
			changed = top
		}
		switch {
		case !ok:
			problems = append(problems, at+" is missing")
		case have.Dir != want.Dir:
			problems = append(problems, at+" changed between file and folder")
		case !rehash && have.FileID != want.FileID:
			problems = append(problems, at+" is a different file")
		case want.Dir:
		case have.Size != want.Size || !have.Modified.Equal(want.Modified):
			problems = append(problems, at+" was written")
		case !rehash && !changed.IsZero() && !have.Changed.Equal(changed):
			problems = append(problems, at+" was changed")
		case have.Digest != nil && want.Digest != nil && *have.Digest != *want.Digest:
			problems = append(problems, at+" holds other bytes")
		}
	}
	for p := range got {
		problems = append(problems, path.Join(rel, p)+" was added")
	}
	if len(problems) == 0 {
		return nil
	}
	slices.Sort(problems)
	if len(problems) > 3 {
		problems = append(problems[:3], fmt.Sprintf("%d more", len(problems)-3))
	}
	return errors.New(strings.Join(problems, "; "))
}

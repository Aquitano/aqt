package organize

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
)

// Item is one file or folder of a moved object. Path is relative to the
// object, "." for the object itself. On NTFS and ReFS a rename keeps the file
// record, so the same FileID also carries the streams, times, attributes,
// owner and permissions the file had.
type Item struct {
	Path     string       `json:"path"`
	Dir      bool         `json:"dir,omitempty"`
	Size     int64        `json:"size,omitempty"`
	Modified time.Time    `json:"modified,omitzero"`
	FileID   uint64       `json:"file_id,omitempty"`
	Digest   *disk.Digest `json:"blake3,omitempty"`
}

// snapshot lists the object at rel below root and everything inside it
// without following links. It refuses links, junctions and cloud
// placeholders anywhere in the object. hash also reads every file's digest.
func snapshot(ctx context.Context, root, rel string, hash bool) ([]Item, error) {
	native := filepath.FromSlash(rel)
	parent := filepath.Dir(native)
	if _, err := disk.Folders(root, parent, false); err != nil {
		return nil, err
	}
	entries, err := disk.List(filepath.Join(root, parent))
	if err != nil {
		return nil, err
	}
	i := slices.IndexFunc(entries, func(e disk.Entry) bool { return e.Name == filepath.Base(native) })
	if i < 0 {
		return nil, &os.PathError{Op: "find", Path: rel, Err: fs.ErrNotExist}
	}
	var items []Item
	return items, walk(ctx, root, rel, ".", entries[i], hash, &items)
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
		it.Size, it.Modified = e.Size, e.Modified
		if hash {
			d, info, err := disk.HashOrdinaryInfo(ctx, root, filepath.FromSlash(at))
			if err != nil {
				return err
			}
			if info.Size() != e.Size || !info.ModTime().Equal(e.Modified) {
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

// verifyAt checks that the object at rel is exactly the baseline: every file
// and folder once, nothing added. Without rehash it must be the same file
// system objects, unwritten since. FAT and exFAT give a moved object new IDs,
// so after a move there rehash compares the bytes instead.
func verifyAt(ctx context.Context, root, rel string, base []Item, rehash bool) error {
	now, err := snapshot(ctx, root, rel, rehash)
	if err != nil {
		return err
	}
	got := make(map[string]Item, len(now))
	for _, it := range now {
		got[it.Path] = it
	}
	var problems []string
	for _, want := range base {
		have, ok := got[want.Path]
		delete(got, want.Path)
		at := path.Join(rel, want.Path)
		switch {
		case !ok:
			problems = append(problems, at+" is missing")
		case have.Dir != want.Dir:
			problems = append(problems, at+" changed between file and folder")
		case !rehash && have.FileID != want.FileID:
			problems = append(problems, at+" is a different file")
		case !want.Dir && (have.Size != want.Size || !have.Modified.Equal(want.Modified)):
			problems = append(problems, at+" was written")
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

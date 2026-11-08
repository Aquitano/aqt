// Package organize renames reviewed files and folders within one volume. A
// person or agent writes the moves; Prepare records exactly what each move
// covers, Apply moves only that, verifies it and journals every step, and
// Undo puts unchanged moves back. Nothing is copied, replaced or deleted.
package organize

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
)

// Plan is a move list and, once prepared, the baseline each move must match.
// Paths are relative to Root and use forward slashes.
type Plan struct {
	Root       string           `json:"root"`
	Volume     disk.Fingerprint `json:"volume,omitzero"`
	PreparedAt time.Time        `json:"prepared_at,omitzero"`
	Moves      []Move           `json:"moves"`
}

type Move struct {
	From     string `json:"from"`
	To       string `json:"to"`
	Reason   string `json:"reason,omitempty"`
	Baseline []Item `json:"baseline,omitempty"`
}

// Totals counts the files, folders and file bytes a prepared move covers.
func (m Move) Totals() (files, folders int, size int64) {
	for _, it := range m.Baseline {
		if it.Dir {
			folders++
		} else {
			files++
			size += it.Size
		}
	}
	return files, folders, size
}

// Read loads a move list or prepared plan and checks that its moves cannot
// collide.
func Read(path string) (Plan, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Plan{}, err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var p Plan
	if err := dec.Decode(&p); err != nil {
		return Plan{}, fmt.Errorf("read %s: %w", path, err)
	}
	return p, p.validate()
}

// JournalPath is where Apply and Undo record each step of the plan at path.
// The extension is matched without case, so every spelling Windows accepts
// for one plan finds one journal.
func JournalPath(plan string) string {
	if ext := filepath.Ext(plan); strings.EqualFold(ext, ".json") {
		plan = strings.TrimSuffix(plan, ext)
	}
	return plan + ".journal.jsonl"
}

// Mount describes the volume holding root. Windows identifies it by its
// fingerprint. Elsewhere the check passes, and inode numbers survive renames
// within one file system.
func Mount(root string) (disk.Volume, error) {
	if runtime.GOOS != "windows" {
		return disk.Volume{Root: root, Fingerprint: disk.Fingerprint{StableIDs: true}}, nil
	}
	v, _, err := disk.Locate(root)
	return v, err
}

// validate normalizes every path and rejects moves that escape the root or
// overlap. Keeping every source and destination apart makes the moves
// independent of their order.
func (p *Plan) validate() error {
	if !filepath.IsAbs(p.Root) {
		return fmt.Errorf("root %q must be an absolute folder", p.Root)
	}
	if len(p.Moves) == 0 {
		return errors.New("the plan lists no moves")
	}
	type place struct {
		key  string
		path string
		move int
	}
	places := make([]place, 0, 2*len(p.Moves))
	for i := range p.Moves {
		m := &p.Moves[i]
		for _, side := range []*string{&m.From, &m.To} {
			rel := filepath.FromSlash(*side)
			if !filepath.IsLocal(rel) || filepath.Clean(rel) == "." {
				return fmt.Errorf("move %d: %q must be a path inside the root", i+1, *side)
			}
			*side = filepath.ToSlash(filepath.Clean(rel))
			places = append(places, place{key: key(*side), path: *side, move: i + 1})
		}
	}
	slices.SortFunc(places, func(a, b place) int { return strings.Compare(a.key, b.key) })
	for i := 1; i < len(places); i++ {
		if a, b := places[i-1], places[i]; strings.HasPrefix(b.key, a.key) {
			return fmt.Errorf("%s (move %d) and %s (move %d) overlap", a.path, a.move, b.path, b.move)
		}
	}
	return nil
}

// key compares paths without case, because Windows file systems ignore it.
// A path equals or lies inside another when its key starts with the other's.
func key(rel string) string {
	return strings.ToLower(rel) + "/"
}

// Status is where an action stands after a command.
type Status string

const (
	Ready        Status = "ready"
	Blocked      Status = "blocked"
	Pending      Status = "pending"
	Moved        Status = "moved"
	AlreadyMoved Status = "already_moved"
	Restored     Status = "restored"
	NotMoved     Status = "not_moved"
)

type Action struct {
	Move    int    `json:"move"`
	From    string `json:"from"`
	To      string `json:"to"`
	Status  Status `json:"status"`
	Problem string `json:"problem,omitempty"`
}

type Actions []Action

// Blocked reports whether any action could not run.
func (as Actions) Blocked() bool {
	return slices.ContainsFunc(as, func(a Action) bool { return a.Status == Blocked })
}

// Prepare records the baseline of every move and, when every move is ready,
// saves the plan at out. Apart from that file it only reads. Each source is respelled as the file system stores it, so undo
// restores the exact names.
func Prepare(ctx context.Context, p *Plan, vol disk.Volume, out string) (Actions, error) {
	out, err := filepath.Abs(out)
	if err != nil {
		return nil, err
	}
	if err := p.checkOut(out); err != nil {
		return nil, err
	}
	actions := make(Actions, len(p.Moves))
	for i := range p.Moves {
		m := &p.Moves[i]
		err := free(p.Root, m.To)
		if err == nil {
			m.From, err = stored(p.Root, m.From)
		}
		if err == nil {
			m.Baseline, err = snapshot(ctx, p.Root, m.From, true)
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		actions[i] = Action{Move: i + 1, From: m.From, To: m.To, Status: Ready}
		if err != nil {
			actions[i].Status, actions[i].Problem = Blocked, err.Error()
		}
	}
	p.blockSharedFiles(actions)
	if actions.Blocked() {
		return actions, nil
	}
	p.Volume = vol.Fingerprint
	p.PreparedAt = time.Now().UTC()
	return actions, p.save(out)
}

// stored spells rel as the file system stores each of its parts.
func stored(root, rel string) (string, error) {
	parts := strings.Split(rel, "/")
	for i := range parts {
		e, err := disk.Lstat(filepath.Join(root, filepath.FromSlash(path.Join(parts[:i+1]...))))
		if err != nil {
			return "", err
		}
		parts[i] = e.Name
	}
	return path.Join(parts...), nil
}

// blockSharedFiles blocks moves that hold hard links to one file: renaming
// one link changes the change time the other move's baseline recorded.
func (p *Plan) blockSharedFiles(actions Actions) {
	type seen struct {
		move int
		path string
	}
	first := map[uint64]seen{}
	for i, m := range p.Moves {
		for _, it := range m.Baseline {
			if it.Dir || it.FileID == 0 {
				continue
			}
			at := path.Join(m.From, it.Path)
			other, ok := first[it.FileID]
			switch {
			case !ok:
				first[it.FileID] = seen{i, at}
			case other.move != i:
				actions[i].Status = Blocked
				actions[i].Problem = fmt.Sprintf("%s and %s (move %d) are hard links to one file; move them together", at, other.path, other.move+1)
			}
		}
	}
}

// checkOut makes sure saving the plan at the absolute path out loses nothing
// and blocks no move: the plan and its journal neither lie inside a move nor
// take a place a destination needs, out is free, and its journal records no
// run and is held by none.
func (p *Plan) checkOut(out string) error {
	abs := out
	if dir, err := filepath.EvalSymlinks(filepath.Dir(abs)); err == nil {
		abs = filepath.Join(dir, filepath.Base(abs))
	}
	root := p.Root
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		root = resolved
	}
	for _, file := range []string{abs, JournalPath(abs)} {
		rel, err := filepath.Rel(root, file)
		if err != nil || !filepath.IsLocal(rel) {
			continue
		}
		k := key(filepath.ToSlash(rel))
		for i, m := range p.Moves {
			if strings.HasPrefix(k, key(m.From)) || strings.HasPrefix(k, key(m.To)) || strings.HasPrefix(key(m.To), k) {
				return fmt.Errorf("%s would collide with move %d; save the plan outside what it moves", file, i+1)
			}
		}
	}
	if !missing(abs) {
		return fmt.Errorf("%s exists; delete it to prepare again, or save the plan elsewhere", out)
	}
	journal, err := claim(JournalPath(abs), false)
	if err != nil || journal == nil {
		return err
	}
	defer journal.Close()
	info, err := journal.Stat()
	if err == nil && info.Size() > 0 {
		err = fmt.Errorf("%s records a run of a plan by this name; prepare into a new file", journal.Name())
	}
	return err
}

// claim opens the journal at path and locks it until the file is closed.
// Without create it returns no file when there is no journal.
func claim(path string, create bool) (*os.File, error) {
	flag := os.O_RDWR
	if create {
		flag |= os.O_CREATE
	}
	f, err := os.OpenFile(path, flag, 0o600)
	if !create && errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := disk.Lock(f); err != nil {
		f.Close()
		if errors.Is(err, disk.ErrLocked) {
			err = errors.New("another run of this plan holds it")
		}
		return nil, fmt.Errorf("journal %s: %w", path, err)
	}
	return f, nil
}

// save checks out again, because reading the sources took a while, writes the
// plan beside it and publishes it with a rename that refuses an existing
// path, so nothing that appeared meanwhile is replaced.
func (p *Plan) save(out string) error {
	if err := p.checkOut(out); err != nil {
		return err
	}
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(out), ".plan-*")
	if err != nil {
		return err
	}
	_, err = tmp.Write(append(data, '\n'))
	err = errors.Join(err, tmp.Sync(), tmp.Close())
	if err == nil {
		err = disk.Move(tmp.Name(), out)
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
	}
	return err
}

// NewFolders lists the folders that apply would create for the destinations,
// so a review sees new structure apart from moves into existing folders.
func NewFolders(p Plan) []string {
	seen := map[string]bool{}
	var out []string
	for _, m := range p.Moves {
		for _, dir := range missingFolders(p.Root, m.To) {
			id := dir
			if runtime.GOOS == "windows" {
				id = key(dir)
			}
			if !seen[id] {
				seen[id] = true
				out = append(out, dir)
			}
		}
	}
	slices.Sort(out)
	return out
}

// missingFolders lists the folders above rel that do not exist yet, outermost
// first.
func missingFolders(root, rel string) []string {
	var dirs []string
	for dir := path.Dir(rel); dir != "." && missing(filepath.Join(root, filepath.FromSlash(dir))); dir = path.Dir(dir) {
		dirs = append(dirs, dir)
	}
	slices.Reverse(dirs)
	return dirs
}

// free checks that nothing occupies rel and that its existing folders are
// ordinary ones.
func free(root, rel string) error {
	native := filepath.FromSlash(rel)
	if err := disk.Folders(root, filepath.Dir(native), false); err != nil {
		return err
	}
	_, err := os.Lstat(filepath.Join(root, native))
	switch {
	case err == nil:
		return fmt.Errorf("%s already exists", rel)
	case errors.Is(err, fs.ErrNotExist):
		return nil
	default:
		return err
	}
}

func missing(p string) bool {
	_, err := os.Lstat(p)
	return errors.Is(err, fs.ErrNotExist)
}

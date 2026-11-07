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

// Write saves a prepared plan. A plan that has a journal was applied, so
// replacing it would leave that journal describing another plan.
func Write(path string, p Plan) error {
	if _, err := os.Lstat(JournalPath(path)); err == nil {
		return fmt.Errorf("%s was applied and has a journal; prepare into a new file", path)
	}
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o600)
}

// JournalPath is where Apply and Undo record each step of the plan at path.
func JournalPath(plan string) string {
	return strings.TrimSuffix(plan, ".json") + ".journal.jsonl"
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

// Open reads a prepared plan and the volume it was prepared on.
func Open(path string) (Plan, disk.Volume, error) {
	p, err := Read(path)
	if err != nil {
		return Plan{}, disk.Volume{}, err
	}
	if p.PreparedAt.IsZero() {
		return Plan{}, disk.Volume{}, fmt.Errorf("%s is not prepared; run `attic organize prepare` on it first", path)
	}
	for i, m := range p.Moves {
		if len(m.Baseline) == 0 {
			return Plan{}, disk.Volume{}, fmt.Errorf("move %d has no baseline; prepare the plan again", i+1)
		}
	}
	v, err := Mount(p.Root)
	if err != nil {
		return Plan{}, disk.Volume{}, err
	}
	if v.Fingerprint != p.Volume {
		return Plan{}, disk.Volume{}, fmt.Errorf("the disk at %s is not the one the plan was prepared on", p.Root)
	}
	return p, v, nil
}

// validate normalizes every path and rejects moves that escape the root or
// overlap. Two places overlap when one equals or contains the other, compared
// without case because Windows file systems ignore it. Keeping every source
// and destination apart makes the moves independent of their order.
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
			places = append(places, place{key: strings.ToLower(*side) + "/", path: *side, move: i + 1})
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

// Prepare records the baseline of every move and reports the ones that cannot
// run. It reads and hashes the sources and changes nothing. The plan is ready
// only when every action is.
func Prepare(ctx context.Context, p *Plan, vol disk.Volume) ([]Action, error) {
	actions := make([]Action, len(p.Moves))
	for i := range p.Moves {
		m := &p.Moves[i]
		a := Action{Move: i + 1, From: m.From, To: m.To, Status: Ready}
		base, err := snapshot(ctx, p.Root, m.From, true)
		if err == nil {
			err = free(p.Root, m.To)
		}
		if ctx.Err() != nil {
			return actions, ctx.Err()
		}
		if err != nil {
			a.Status, a.Problem = Blocked, err.Error()
		}
		m.Baseline = base
		actions[i] = a
	}
	p.Volume = vol.Fingerprint
	p.PreparedAt = time.Now().UTC()
	return actions, nil
}

// NewFolders lists the folders that apply would create for the destinations,
// so a review sees new structure apart from moves into existing folders.
func NewFolders(p Plan) []string {
	seen := map[string]bool{}
	var out []string
	for _, m := range p.Moves {
		for dir := path.Dir(m.To); dir != "." && !seen[dir]; dir = path.Dir(dir) {
			seen[dir] = true
			if !missing(filepath.Join(p.Root, filepath.FromSlash(dir))) {
				break
			}
			out = append(out, dir)
		}
	}
	slices.Sort(out)
	return out
}

// free checks that nothing occupies rel and that its existing folders are
// ordinary ones.
func free(root, rel string) error {
	native := filepath.FromSlash(rel)
	if _, err := disk.Folders(root, filepath.Dir(native), false); err != nil {
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

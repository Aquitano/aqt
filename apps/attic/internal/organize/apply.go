package organize

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
)

// Journal events. moving and restoring are written before a rename, moved and
// restored once the object is verified at its new place.
const (
	moving    = "moving"
	moved     = "moved"
	restoring = "restoring"
	restored  = "restored"
	created   = "created"
	removed   = "removed"
)

type event struct {
	Move   int    `json:"move"`
	From   string `json:"from"`
	To     string `json:"to"`
	Event  string `json:"event"`
	Folder string `json:"folder,omitempty"`
	// Changed is the object's change time once a rename is verified, since
	// the rename itself moved it.
	Changed time.Time `json:"changed,omitzero"`
	At      time.Time `json:"at"`
}

// state is a move as its journal leaves it: the last lifecycle event, empty
// when the move was never attempted, the object's change time after the last
// verified rename, and the folders the moves made for it that still exist.
type state struct {
	last    string
	changed time.Time
	folders []string
}

func (s *state) add(e event) {
	switch e.Event {
	case created:
		s.folders = append(s.folders, e.Folder)
	case removed:
		s.folders = slices.DeleteFunc(s.folders, func(dir string) bool { return dir == e.Folder })
	default:
		s.last, s.changed = e.Event, e.Changed
	}
}

// Run applies or undoes one prepared plan. It holds the plan's journal open
// and locked, so a second run of the same plan fails until Close.
type Run struct {
	plan     Plan
	planPath string
	vol      disk.Volume
	journal  *os.File
	states   []state
}

type Result struct {
	Root    string  `json:"root"`
	Plan    string  `json:"plan"`
	Journal string  `json:"journal"`
	Actions Actions `json:"actions"`
}

// Open reads the prepared plan at path, checks that its disk is attached and
// replays its journal. The plan is read once before its journal is created,
// so a wrong file gets none, and again under the journal's lock, so prepare
// cannot replace it underneath the run.
func Open(path string) (*Run, error) {
	if _, err := readPrepared(path); err != nil {
		return nil, err
	}
	journal, err := claim(JournalPath(path), true)
	if err != nil {
		return nil, err
	}
	r, err := openRun(path, journal)
	if err != nil {
		journal.Close()
		return nil, err
	}
	return r, nil
}

func openRun(path string, journal *os.File) (*Run, error) {
	p, err := readPrepared(path)
	if err != nil {
		return nil, err
	}
	vol, err := Mount(p.Root)
	if err != nil {
		return nil, err
	}
	if vol.Fingerprint != p.Volume {
		return nil, fmt.Errorf("the disk at %s is not the one the plan was prepared on", p.Root)
	}
	r := &Run{plan: p, planPath: path, vol: vol, journal: journal, states: make([]state, len(p.Moves))}
	if err := r.load(); err != nil {
		return nil, fmt.Errorf("journal %s: %w", journal.Name(), err)
	}
	return r, nil
}

func readPrepared(path string) (Plan, error) {
	p, err := Read(path)
	if err != nil {
		return Plan{}, err
	}
	if p.PreparedAt.IsZero() {
		return Plan{}, fmt.Errorf("%s is not prepared; run `attic organize prepare` on it first", path)
	}
	for i, m := range p.Moves {
		if len(m.Baseline) == 0 {
			return Plan{}, fmt.Errorf("move %d has no baseline; prepare the plan again", i+1)
		}
	}
	return p, nil
}

func (r *Run) Close() error { return r.journal.Close() }

// load replays the journal's complete lines. A last line without its newline
// was cut short by a crash and never counted; it is cut off so the next event
// starts a line of its own. A file without a single complete line could be
// anything, so it is left alone.
func (r *Run) load() error {
	data, err := io.ReadAll(r.journal)
	if err != nil {
		return err
	}
	if len(data) == 0 {
		return disk.SyncDir(filepath.Dir(r.journal.Name()))
	}
	complete := int64(bytes.LastIndexByte(data, '\n') + 1)
	if complete == 0 {
		return errors.New("it holds no complete entry, so apply did not write it; delete it only if an apply stopped before its first move")
	}
	if err := r.replay(data[:complete]); err != nil {
		return err
	}
	if complete == int64(len(data)) {
		return nil
	}
	if err := r.journal.Truncate(complete); err != nil {
		return err
	}
	_, err = r.journal.Seek(complete, io.SeekStart)
	return err
}

func (r *Run) replay(data []byte) error {
	n := 0
	for line := range bytes.Lines(data) {
		n++
		var e event
		if err := json.Unmarshal(line, &e); err != nil {
			return fmt.Errorf("line %d is damaged: %w", n, err)
		}
		if e.Move < 1 || e.Move > len(r.plan.Moves) {
			return fmt.Errorf("line %d names a move this plan does not have", n)
		}
		m := r.plan.Moves[e.Move-1]
		switch {
		case m.From != e.From || m.To != e.To:
			return fmt.Errorf("line %d names a move this plan does not have", n)
		case (e.Event == created || e.Event == removed) && (path.Clean(e.Folder) != e.Folder ||
			!strings.HasPrefix(m.To, e.Folder+"/") && !strings.HasPrefix(m.From, e.Folder+"/")):
			return fmt.Errorf("line %d names a folder that move %d cannot have made", n, e.Move)
		case !slices.Contains([]string{moving, moved, restoring, restored, created, removed}, e.Event):
			return fmt.Errorf("line %d holds the unknown event %q", n, e.Event)
		}
		r.states[e.Move-1].add(e)
	}
	return nil
}

func (r *Run) record(i int, e event) error {
	m := r.plan.Moves[i]
	e.Move, e.From, e.To, e.At = i+1, m.From, m.To, time.Now().UTC()
	line, err := json.Marshal(e)
	if err != nil {
		return err
	}
	if _, err := r.journal.Write(append(line, '\n')); err != nil {
		return err
	}
	if err := r.journal.Sync(); err != nil {
		return err
	}
	r.states[i].add(e)
	return nil
}

func (r *Run) result() Result {
	res := Result{Root: r.plan.Root, Plan: r.planPath, Journal: r.journal.Name(), Actions: make(Actions, len(r.plan.Moves))}
	for i, m := range r.plan.Moves {
		res.Actions[i] = Action{Move: i + 1, From: m.From, To: m.To}
	}
	return res
}

func (r *Run) path(rel string) string {
	return filepath.Join(r.plan.Root, filepath.FromSlash(rel))
}

// verify checks that the object at rel is exactly move i's baseline and
// returns its change time. FAT and exFAT give a moved object new IDs and keep
// no change time, so there the bytes are compared. top is the change time the
// object itself should have. Right after a rename that time is new, so the
// caller passes none; otherwise, when top is unknown, a single file's bytes
// are compared instead.
func (r *Run) verify(ctx context.Context, i int, rel string, top time.Time, renamed bool) (time.Time, error) {
	m := r.plan.Moves[i]
	rehash := !r.vol.StableIDs
	hash := rehash || (!renamed && top.IsZero() && !m.Baseline[0].Dir)
	now, err := snapshot(ctx, r.plan.Root, rel, hash)
	if err != nil {
		return time.Time{}, err
	}
	return now[0].Changed, compare(rel, m.Baseline, now, rehash, top)
}

// expected is the change time move i's object should have at rel: the
// baseline's before any rename, the journal's after a verified one, and zero
// while a rename is unsettled.
func (r *Run) expected(i int, rel string) time.Time {
	m, s := r.plan.Moves[i], r.states[i]
	switch {
	case s.last == "" && rel == m.From:
		return m.Baseline[0].Changed
	case s.last == moved && rel == m.To, s.last == restored && rel == m.From:
		return s.changed
	}
	return time.Time{}
}

// locate finds move i's object, at its source or its destination, checks that
// it is exactly the baseline there and returns its change time. When only one
// place is taken, that one holds it. When both are, the journal decides,
// unless it shows a rename under way.
func (r *Run) locate(ctx context.Context, i int) (string, time.Time, error) {
	m := r.plan.Moves[i]
	from, to := !missing(r.path(m.From)), !missing(r.path(m.To))
	at := m.From
	switch last := r.states[i].last; {
	case !from && !to:
		return "", time.Time{}, fmt.Errorf("neither %s nor %s exists", m.From, m.To)
	case to && (!from || last == moved):
		at = m.To
	case to && (last == moving || last == restoring):
		return "", time.Time{}, errors.New("an earlier run stopped during this move and both places are taken; decide by hand")
	}
	changed, err := r.verify(ctx, i, at, r.expected(i, at), false)
	return at, changed, err
}

// Apply runs the plan. It first checks every action and moves nothing if one
// is blocked; moves an earlier run finished must still match too. Each move
// is journalled before its rename and again once the object is verified at
// its destination. Running Apply again resumes: verified moves are kept, and
// an interrupted one is reconciled from what is on disk.
func (r *Run) Apply(ctx context.Context) (Result, error) {
	res := r.result()
	var pending []int
	for i, m := range r.plan.Moves {
		a := &res.Actions[i]
		at, changed, err := r.locate(ctx, i)
		if err == nil && at == m.From {
			err = free(r.plan.Root, m.To)
		}
		if ctx.Err() != nil {
			return res, ctx.Err()
		}
		switch {
		case err != nil:
			a.Status, a.Problem = Blocked, err.Error()
		case at == m.From:
			a.Status = Pending
			pending = append(pending, i)
		default:
			a.Status = AlreadyMoved
			if r.states[i].last != moved {
				if err := r.record(i, event{Event: moved, Changed: changed}); err != nil {
					return res, err
				}
			}
		}
	}
	if res.Actions.Blocked() {
		return res, nil
	}
	for _, i := range pending {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		a := &res.Actions[i]
		problem, err := r.move(ctx, i, r.plan.Moves[i].From, r.plan.Moves[i].To, moving, moved)
		if err != nil {
			return res, err
		}
		if problem != "" {
			a.Status, a.Problem = Blocked, problem
			return res, nil
		}
		a.Status = Moved
	}
	return res, nil
}

// Undo moves every applied move back, last first, when its object is still
// exactly the baseline and its original place is free. A move that fails
// either check stays where it is and is reported; the others still go back.
// Folders the moves made are removed once they are empty again.
func (r *Run) Undo(ctx context.Context) (Result, error) {
	res := r.result()
	for i := len(r.plan.Moves) - 1; i >= 0; i-- {
		m := r.plan.Moves[i]
		a := &res.Actions[i]
		last := r.states[i].last
		if last == "" || last == restored {
			a.Status = NotMoved
			continue
		}
		at, changed, err := r.locate(ctx, i)
		if err == nil && at == m.To {
			err = free(r.plan.Root, m.From)
		}
		if ctx.Err() != nil {
			return res, ctx.Err()
		}
		switch {
		case err != nil:
			a.Status, a.Problem = Blocked, err.Error()
		case at == m.From:
			// Either an earlier undo renamed it back before journalling, or
			// it never left.
			if err := r.record(i, event{Event: restored, Changed: changed}); err != nil {
				return res, err
			}
			a.Status = NotMoved
			if last == restoring {
				a.Status = Restored
			}
		default:
			problem, err := r.move(ctx, i, m.To, m.From, restoring, restored)
			if err != nil {
				return res, err
			}
			a.Status, a.Problem = Restored, problem
			if problem != "" {
				a.Status = Blocked
			}
		}
	}
	return res, r.removeFolders()
}

// removeFolders removes the folders the moves made for moves that are back at
// their source, deepest first, when they are ordinary and empty again. A
// folder that is gone leaves the journal, so one made later under its name
// stays. A folder that another move still fills is retried by the next undo.
func (r *Run) removeFolders() error {
	owners := map[string][]int{}
	for i, s := range r.states {
		if s.last == restored {
			for _, dir := range s.folders {
				owners[dir] = append(owners[dir], i)
			}
		}
	}
	for _, dir := range slices.Backward(slices.Sorted(maps.Keys(owners))) {
		gone := missing(r.path(dir))
		if !gone && (disk.Folders(r.plan.Root, filepath.FromSlash(dir), false) != nil || disk.RemoveDir(r.path(dir)) != nil) {
			continue
		}
		for _, i := range owners[dir] {
			if err := r.record(i, event{Event: removed, Folder: dir}); err != nil {
				return err
			}
		}
	}
	return nil
}

// move renames move i's object from one place to the other and verifies it
// there. A problem means the object is back where it started; an error means
// the run must stop, and says where the object is when it could not go back.
func (r *Run) move(ctx context.Context, i int, from, to, start, done string) (string, error) {
	if !disk.Present(r.vol) {
		return "the disk changed since the run started", nil
	}
	top := r.expected(i, from)
	if err := r.record(i, event{Event: start}); err != nil {
		return "", err
	}
	// A folder is journalled before it is made, so undo removes it even when
	// the run stops in between.
	for _, dir := range missingFolders(r.plan.Root, to) {
		if err := r.record(i, event{Event: created, Folder: dir}); err != nil {
			return "", err
		}
	}
	if err := disk.Folders(r.plan.Root, filepath.Dir(filepath.FromSlash(to)), true); err != nil {
		return err.Error(), nil
	}
	// The rename replaces a file's change time, the one sign of an edit that
	// kept its size and modified time, so that sign is read right before.
	if r.vol.StableIDs && !r.plan.Moves[i].Baseline[0].Dir {
		if _, err := r.verify(ctx, i, from, top, false); ctx.Err() != nil {
			return "", ctx.Err()
		} else if err != nil {
			return err.Error(), nil
		}
	}
	if err := disk.Move(r.path(from), r.path(to)); err != nil {
		return err.Error(), nil
	}
	// The rename resolves both paths again, so a folder swapped for a junction
	// or a file saved over meanwhile would move something else. Only the
	// planned object stays, and it goes back only through ordinary folders.
	changed, verr := r.verify(ctx, i, to, time.Time{}, true)
	if verr == nil {
		return "", r.record(i, event{Event: done, Changed: changed})
	}
	if ctx.Err() != nil {
		// The journal still says the move started; the next run checks both
		// places and finishes or reports it.
		return "", ctx.Err()
	}
	err := disk.Folders(r.plan.Root, filepath.Dir(filepath.FromSlash(to)), false)
	if err == nil {
		err = disk.Folders(r.plan.Root, filepath.Dir(filepath.FromSlash(from)), false)
	}
	if err == nil {
		err = disk.Move(r.path(to), r.path(from))
	}
	if err != nil {
		return "", fmt.Errorf("%s did not match the plan after the move and stays at %s: %w", from, to, errors.Join(verr, err))
	}
	back := restored
	if start == restoring {
		back = moved
	}
	if err := r.record(i, event{Event: back}); err != nil {
		return "", err
	}
	return "did not match the plan after the move, so it went back: " + verr.Error(), nil
}

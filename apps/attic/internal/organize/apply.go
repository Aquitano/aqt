package organize

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
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
)

type event struct {
	Move   int       `json:"move"`
	From   string    `json:"from"`
	To     string    `json:"to"`
	Event  string    `json:"event"`
	Folder string    `json:"folder,omitempty"`
	At     time.Time `json:"at"`
}

// state is a move as its journal leaves it: the last lifecycle event, empty
// when the move was never attempted, and the folders apply made for it.
type state struct {
	last    string
	folders []string
}

type journal struct {
	f      *os.File
	path   string
	plan   *Plan
	states []state
}

// openJournal replays the journal at path. A final line without its newline
// was cut short by a crash and never counted; it is cut off so the next event
// starts a line of its own.
func openJournal(path string, p *Plan) (*journal, error) {
	j := &journal{path: path, plan: p, states: make([]state, len(p.Moves))}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		err = nil
	}
	if err == nil {
		err = j.replay(data)
	}
	// Windows opens an appending file without the right to truncate it.
	if torn := len(data) - bytes.LastIndexByte(data, '\n') - 1; err == nil && torn > 0 {
		err = os.Truncate(path, int64(len(data)-torn))
	}
	if err == nil {
		j.f, err = os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	}
	if err != nil {
		return nil, fmt.Errorf("journal %s: %w", path, err)
	}
	return j, nil
}

func (j *journal) replay(data []byte) error {
	lines := bytes.Split(data, []byte{'\n'})
	for n, line := range lines[:len(lines)-1] {
		var e event
		if err := json.Unmarshal(line, &e); err != nil {
			return fmt.Errorf("line %d is damaged: %w", n+1, err)
		}
		if e.Move < 1 || e.Move > len(j.plan.Moves) || j.plan.Moves[e.Move-1].From != e.From || j.plan.Moves[e.Move-1].To != e.To {
			return fmt.Errorf("line %d names a move this plan does not have", n+1)
		}
		s := &j.states[e.Move-1]
		if e.Event == created {
			s.folders = append(s.folders, e.Folder)
		} else {
			s.last = e.Event
		}
	}
	return nil
}

func (j *journal) record(i int, name, folder string) error {
	m := j.plan.Moves[i]
	line, err := json.Marshal(event{Move: i + 1, From: m.From, To: m.To, Event: name, Folder: folder, At: time.Now().UTC()})
	if err != nil {
		return err
	}
	if _, err := j.f.Write(append(line, '\n')); err != nil {
		return err
	}
	if err := j.f.Sync(); err != nil {
		return err
	}
	if name == created {
		j.states[i].folders = append(j.states[i].folders, folder)
	} else {
		j.states[i].last = name
	}
	return nil
}

func (j *journal) Close() error { return j.f.Close() }

type Result struct {
	Root    string   `json:"root"`
	Plan    string   `json:"plan"`
	Journal string   `json:"journal"`
	Actions []Action `json:"actions"`
}

// Blocked reports whether any action could not run.
func (r Result) Blocked() bool {
	return slices.ContainsFunc(r.Actions, func(a Action) bool { return a.Status == Blocked })
}

type place int

const (
	atFrom place = iota
	atTo
)

// runner applies or undoes one plan on one mounted volume.
type runner struct {
	plan    *Plan
	vol     disk.Volume
	journal *journal
}

func (r *runner) path(rel string) string {
	return filepath.Join(r.plan.Root, filepath.FromSlash(rel))
}

// rehash says whether verifying move i must reread its bytes: on file systems
// without stable IDs, once the move may have renamed the object.
func (r *runner) rehash(i int) bool {
	return !r.vol.StableIDs && r.journal.states[i].last != ""
}

// locate finds where move i's object is. The journal answers for settled
// moves; an interrupted one counts as moved or not only when one side holds
// exactly the baseline and the other side is empty.
func (r *runner) locate(ctx context.Context, i int) (place, error) {
	m := r.plan.Moves[i]
	switch r.journal.states[i].last {
	case "", restored:
		return atFrom, nil
	case moved:
		return atTo, nil
	}
	fromErr := verifyAt(ctx, r.plan.Root, m.From, m.Baseline, r.rehash(i))
	toErr := verifyAt(ctx, r.plan.Root, m.To, m.Baseline, r.rehash(i))
	if ctx.Err() != nil {
		return 0, ctx.Err()
	}
	switch {
	case fromErr == nil && missing(r.path(m.To)):
		return atFrom, nil
	case toErr == nil && missing(r.path(m.From)):
		return atTo, nil
	}
	return 0, fmt.Errorf("an earlier run stopped during this move and neither place holds exactly what was planned; decide by hand. At %s: %v. At %s: %v",
		m.From, describe(fromErr), m.To, describe(toErr))
}

func describe(err error) string {
	if err == nil {
		return "the planned object"
	}
	return err.Error()
}

func missing(p string) bool {
	_, err := os.Lstat(p)
	return errors.Is(err, fs.ErrNotExist)
}

// Apply runs a prepared plan. It first checks every action and moves nothing
// if one is blocked. Each move is journalled before its rename and again once
// the object is verified at its destination. Running Apply again resumes:
// verified moves are kept, and an interrupted one is reconciled from what is
// on disk.
func Apply(ctx context.Context, p *Plan, planPath string, vol disk.Volume) (Result, error) {
	j, err := openJournal(JournalPath(planPath), p)
	if err != nil {
		return Result{}, err
	}
	defer j.Close()
	r := &runner{plan: p, vol: vol, journal: j}
	res := Result{Root: p.Root, Plan: planPath, Journal: j.path, Actions: make([]Action, len(p.Moves))}
	var pending []int
	for i, m := range p.Moves {
		a := &res.Actions[i]
		*a = Action{Move: i + 1, From: m.From, To: m.To}
		where, err := r.locate(ctx, i)
		if err == nil && where == atTo && j.states[i].last != moved {
			err = j.record(i, moved, "")
		}
		if err == nil && where == atFrom {
			err = verifyAt(ctx, p.Root, m.From, m.Baseline, r.rehash(i))
			if err == nil {
				err = free(p.Root, m.To)
			}
		}
		if ctx.Err() != nil {
			return res, ctx.Err()
		}
		switch {
		case err != nil:
			a.Status, a.Problem = Blocked, err.Error()
		case where == atTo:
			a.Status = AlreadyMoved
		default:
			a.Status = Pending
			pending = append(pending, i)
		}
	}
	if res.Blocked() {
		return res, nil
	}
	for _, i := range pending {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		a := &res.Actions[i]
		problem, err := r.move(ctx, i, p.Moves[i].From, p.Moves[i].To, moving, moved)
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
// Folders the moves made that are empty again are removed.
func Undo(ctx context.Context, p *Plan, planPath string, vol disk.Volume) (Result, error) {
	j, err := openJournal(JournalPath(planPath), p)
	if err != nil {
		return Result{}, err
	}
	defer j.Close()
	r := &runner{plan: p, vol: vol, journal: j}
	res := Result{Root: p.Root, Plan: planPath, Journal: j.path, Actions: make([]Action, len(p.Moves))}
	for i := len(p.Moves) - 1; i >= 0; i-- {
		m := p.Moves[i]
		a := &res.Actions[i]
		*a = Action{Move: i + 1, From: m.From, To: m.To}
		where, err := r.locate(ctx, i)
		if err == nil && where == atTo {
			err = verifyAt(ctx, p.Root, m.To, m.Baseline, r.rehash(i))
			if err == nil {
				err = free(p.Root, m.From)
			}
		}
		if ctx.Err() != nil {
			return res, ctx.Err()
		}
		switch last := j.states[i].last; {
		case err != nil:
			a.Status, a.Problem = Blocked, err.Error()
			continue
		case where == atFrom && last == restoring:
			// An earlier undo renamed it back but stopped before journalling.
			if err := j.record(i, restored, ""); err != nil {
				return res, err
			}
		case where == atFrom:
			a.Status = NotMoved
			continue
		default:
			problem, err := r.move(ctx, i, m.To, m.From, restoring, restored)
			if err != nil {
				return res, err
			}
			if problem != "" {
				a.Status, a.Problem = Blocked, problem
				continue
			}
		}
		a.Status = Restored
		folders := j.states[i].folders
		for k := len(folders) - 1; k >= 0; k-- {
			// Only an ordinary folder is removed, and only an empty one can be.
			if info, err := os.Lstat(r.path(folders[k])); err == nil && info.Mode().Type() == fs.ModeDir {
				_ = os.Remove(r.path(folders[k]))
			}
		}
	}
	return res, nil
}

// move renames move i's object from one place to the other and verifies it
// there. A problem means the object is back where it started; an error means
// the run must stop, and says where the object is when it could not go back.
func (r *runner) move(ctx context.Context, i int, from, to, start, done string) (string, error) {
	j := r.journal
	if !disk.Present(r.vol) {
		return "the disk changed since the run started", nil
	}
	if err := j.record(i, start, ""); err != nil {
		return "", err
	}
	made, err := disk.Folders(r.plan.Root, filepath.Dir(filepath.FromSlash(to)), true)
	for _, dir := range made {
		rel, relErr := filepath.Rel(r.plan.Root, dir)
		if relErr == nil {
			if recErr := j.record(i, created, filepath.ToSlash(rel)); recErr != nil {
				return "", recErr
			}
		}
	}
	if err != nil {
		return err.Error(), nil
	}
	if err := disk.Move(r.path(from), r.path(to)); err != nil {
		return err.Error(), nil
	}
	// The rename resolves both paths again, so a folder swapped for a junction
	// or a file saved over meanwhile would move something else. Only the
	// planned object stays.
	if verr := verifyAt(ctx, r.plan.Root, to, r.plan.Moves[i].Baseline, r.rehash(i)); verr != nil {
		if ctx.Err() != nil {
			// The journal still says the move started; the next run checks
			// both places and finishes or reports it.
			return "", ctx.Err()
		}
		if err := disk.Move(r.path(to), r.path(from)); err != nil {
			return "", fmt.Errorf("%s did not match the plan after the move and stays at %s: %w", from, to, errors.Join(verr, err))
		}
		back := restored
		if start == restoring {
			back = moved
		}
		if err := j.record(i, back, ""); err != nil {
			return "", err
		}
		return "did not match the plan after the move, so it went back: " + verr.Error(), nil
	}
	return "", j.record(i, done, "")
}

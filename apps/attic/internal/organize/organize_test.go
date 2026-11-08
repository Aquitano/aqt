package organize

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

func write(t *testing.T, root, rel, data string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
}

func exists(root, rel string) bool {
	_, err := os.Lstat(filepath.Join(root, filepath.FromSlash(rel)))
	return err == nil
}

func prepareAt(t *testing.T, out, root string, moves ...Move) error {
	t.Helper()
	p := Plan{Root: root, Moves: moves}
	if err := p.validate(); err != nil {
		t.Fatal(err)
	}
	vol, err := Mount(root)
	if err != nil {
		t.Fatal(err)
	}
	actions, err := Prepare(context.Background(), &p, vol, out)
	for _, a := range actions {
		if a.Status != Ready {
			t.Fatalf("move %d is %s: %s", a.Move, a.Status, a.Problem)
		}
	}
	return err
}

// prepare saves a ready plan for moves below root and returns its path.
func prepare(t *testing.T, root string, moves ...Move) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "plan.json")
	if err := prepareAt(t, path, root, moves...); err != nil {
		t.Fatal(err)
	}
	return path
}

func open(t *testing.T, path string) *Run {
	t.Helper()
	r, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func run(t *testing.T, path string, cmd func(*Run, context.Context) (Result, error)) Result {
	t.Helper()
	r := open(t, path)
	defer r.Close()
	res, err := cmd(r, context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func statuses(res Result) []Status {
	out := make([]Status, len(res.Actions))
	for i, a := range res.Actions {
		out[i] = a.Status
	}
	return out
}

// rewrite replaces a file's bytes and puts its modified time back.
func rewrite(t *testing.T, root, rel, data string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(rel))
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	write(t, root, rel, data)
	if err := os.Chtimes(path, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
}

func problems(res Result) string {
	var all []string
	for _, a := range res.Actions {
		all = append(all, a.Problem)
	}
	return strings.Join(all, "\n")
}

func TestApplyAndUndoMoveFilesAndWholeFolders(t *testing.T) {
	root := t.TempDir()
	write(t, root, "Inbox/award.pdf", "2014 award")
	write(t, root, "Inbox/Proj/src/logo.png", "logo")
	if err := os.MkdirAll(filepath.Join(root, "Inbox", "Proj", "empty"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "Documents"), 0o700); err != nil {
		t.Fatal(err)
	}
	plan := prepare(t, root,
		Move{From: "Inbox/award.pdf", To: "Documents/School/award.pdf"},
		Move{From: "Inbox/Proj", To: "Projects/Proj"})
	p, err := Read(plan)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(NewFolders(p), ","); got != "Documents/School,Projects" {
		t.Fatalf("new folders = %s", got)
	}

	if got := statuses(run(t, plan, (*Run).Apply)); !slices.Equal(got, []Status{Moved, Moved}) {
		t.Fatalf("apply = %v", got)
	}
	for _, rel := range []string{"Documents/School/award.pdf", "Projects/Proj/src/logo.png", "Projects/Proj/empty"} {
		if !exists(root, rel) {
			t.Errorf("%s is missing after apply", rel)
		}
	}
	if got := statuses(run(t, plan, (*Run).Apply)); !slices.Equal(got, []Status{AlreadyMoved, AlreadyMoved}) {
		t.Fatalf("second apply = %v", got)
	}

	if got := statuses(run(t, plan, (*Run).Undo)); !slices.Equal(got, []Status{Restored, Restored}) {
		t.Fatalf("undo = %v", got)
	}
	for _, rel := range []string{"Inbox/award.pdf", "Inbox/Proj/src/logo.png", "Inbox/Proj/empty"} {
		if !exists(root, rel) {
			t.Errorf("%s is missing after undo", rel)
		}
	}
	for _, rel := range []string{"Documents/School", "Projects"} {
		if exists(root, rel) {
			t.Errorf("undo left the folder %s that apply made", rel)
		}
	}
	if !exists(root, "Documents") {
		t.Error("undo removed Documents, which existed before")
	}
}

func TestPrepareUsesStoredNames(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("only Windows finds a file under another case")
	}
	root := t.TempDir()
	write(t, root, "Inbox/Award.PDF", "award")
	plan := prepare(t, root, Move{From: "inbox/award.pdf", To: "Documents/award.pdf"})
	p, err := Read(plan)
	if err != nil {
		t.Fatal(err)
	}
	if got := p.Moves[0].From; got != "Inbox/Award.PDF" {
		t.Fatalf("from = %s, want the stored name", got)
	}
}

func TestValidateRejectsEscapesAndOverlaps(t *testing.T) {
	for _, tc := range []struct {
		name  string
		moves []Move
	}{
		{"escapes the root", []Move{{From: "a", To: "../b"}}},
		{"names the root", []Move{{From: ".", To: "b"}}},
		{"same destination", []Move{{From: "a", To: "x"}, {From: "b", To: "X"}}},
		{"source inside a moved folder", []Move{{From: "Proj", To: "Projects/Proj"}, {From: "Proj/logo.png", To: "Logos/logo.png"}}},
		{"destination inside a moved folder", []Move{{From: "Proj", To: "Projects/Proj"}, {From: "logo.png", To: "Proj/logo.png"}}},
		{"folder into itself", []Move{{From: "Proj", To: "Proj/Old"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := Plan{Root: t.TempDir(), Moves: tc.moves}
			if err := p.validate(); err == nil {
				t.Fatal("validate accepted the plan")
			}
		})
	}
}

func TestPrepareReplacesOnlyUnusedPlans(t *testing.T) {
	for _, tc := range []struct {
		name, want string
		setup      func(t *testing.T, root string) string
	}{
		{"plan inside a moved folder", "inside move 1", func(t *testing.T, root string) string {
			return filepath.Join(root, "Inbox", "moves.plan.json")
		}},
		{"file that is not a plan", "not a prepared plan", func(t *testing.T, root string) string {
			out := filepath.Join(t.TempDir(), "notes.json")
			write(t, filepath.Dir(out), "notes.json", "my notes")
			return out
		}},
		{"plan that was applied", "records a run", func(t *testing.T, root string) string {
			out := filepath.Join(t.TempDir(), "moves.plan.json")
			write(t, root, "other.txt", "other")
			for range 2 {
				if err := prepareAt(t, out, root, Move{From: "other.txt", To: "Sorted/other.txt"}); err != nil {
					t.Fatal(err)
				}
			}
			run(t, out, (*Run).Apply)
			return out
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			write(t, root, "Inbox/a.txt", "a")
			out := tc.setup(t, root)
			before, _ := os.ReadFile(out)
			err := prepareAt(t, out, root, Move{From: "Inbox", To: "Sorted/Inbox"})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("prepare = %v, want %q", err, tc.want)
			}
			if after, _ := os.ReadFile(out); string(after) != string(before) {
				t.Fatal("prepare changed the file at out")
			}
		})
	}
}

func TestApplyMovesNothingWhenAnyActionIsBlocked(t *testing.T) {
	for _, tc := range []struct {
		name, want string
		change     func(t *testing.T, root string)
	}{
		{"file written", "was written", func(t *testing.T, root string) { write(t, root, "b.txt", "edited since prepare") }},
		{"file rewritten with its old size and time", "was changed", func(t *testing.T, root string) { rewrite(t, root, "b.txt", "B") }},
		{"file added to a folder", "was added", func(t *testing.T, root string) { write(t, root, "Proj/new.txt", "new") }},
		{"destination taken", "already exists", func(t *testing.T, root string) { write(t, root, "Sorted/b.txt", "other") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			write(t, root, "a.txt", "a")
			write(t, root, "b.txt", "b")
			write(t, root, "Proj/logo.png", "logo")
			plan := prepare(t, root,
				Move{From: "a.txt", To: "Sorted/a.txt"},
				Move{From: "b.txt", To: "Sorted/b.txt"},
				Move{From: "Proj", To: "Projects/Proj"})
			tc.change(t, root)

			res := run(t, plan, (*Run).Apply)
			if !res.Actions.Blocked() || !strings.Contains(problems(res), tc.want) {
				t.Fatalf("apply did not block with %q: %+v", tc.want, res.Actions)
			}
			if !exists(root, "a.txt") || !exists(root, "Proj/logo.png") || exists(root, "Projects") {
				t.Fatal("apply moved something although an action was blocked")
			}
		})
	}
}

func TestApplyResumesInterruptedMoves(t *testing.T) {
	root := t.TempDir()
	write(t, root, "a.txt", "a")
	write(t, root, "b.txt", "b")
	plan := prepare(t, root, Move{From: "a.txt", To: "a2.txt"}, Move{From: "b.txt", To: "b2.txt"})
	// The first run renamed a.txt but stopped before journalling it, and
	// stopped before renaming b.txt, halfway through writing a line.
	r := open(t, plan)
	for i := range 2 {
		if err := r.record(i, event{Event: moving}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := r.journal.WriteString(`{"move":2,"fr`); err != nil {
		t.Fatal(err)
	}
	r.Close()
	if err := os.Rename(filepath.Join(root, "a.txt"), filepath.Join(root, "a2.txt")); err != nil {
		t.Fatal(err)
	}

	if got := statuses(run(t, plan, (*Run).Apply)); !slices.Equal(got, []Status{AlreadyMoved, Moved}) {
		t.Fatalf("resumed apply = %v", got)
	}
	if !exists(root, "a2.txt") || !exists(root, "b2.txt") || exists(root, "a.txt") || exists(root, "b.txt") {
		t.Fatal("resume did not finish both moves")
	}
	if got := statuses(run(t, plan, (*Run).Apply)); !slices.Equal(got, []Status{AlreadyMoved, AlreadyMoved}) {
		t.Fatalf("journal after resume = %v", got)
	}
}

func TestApplyRechecksFinishedMoves(t *testing.T) {
	root := t.TempDir()
	write(t, root, "a.txt", "a")
	plan := prepare(t, root, Move{From: "a.txt", To: "Sorted/a.txt"})
	run(t, plan, (*Run).Apply)
	rewrite(t, root, "Sorted/a.txt", "A")

	if a := run(t, plan, (*Run).Apply).Actions[0]; a.Status != Blocked || !strings.Contains(a.Problem, "was changed") {
		t.Fatalf("apply after an edit = %+v", a)
	}
}

func TestApplyAfterAFailedRenameComparesBytes(t *testing.T) {
	root := t.TempDir()
	write(t, root, "a.txt", "a")
	plan := prepare(t, root, Move{From: "a.txt", To: "Sorted/a.txt"})
	// An earlier run journalled the move, and then its rename failed.
	r := open(t, plan)
	if err := r.record(0, event{Event: moving}); err != nil {
		t.Fatal(err)
	}
	r.Close()
	rewrite(t, root, "a.txt", "A")

	if a := run(t, plan, (*Run).Apply).Actions[0]; a.Status != Blocked || !strings.Contains(a.Problem, "holds other bytes") {
		t.Fatalf("apply after the failed rename = %+v", a)
	}
}

func TestMoveRechecksAFileRightBeforeItsRename(t *testing.T) {
	root := t.TempDir()
	write(t, root, "a.txt", "a")
	plan := prepare(t, root, Move{From: "a.txt", To: "Sorted/a.txt"})
	r := open(t, plan)
	defer r.Close()
	rewrite(t, root, "a.txt", "A")

	problem, err := r.move(context.Background(), 0, "a.txt", "Sorted/a.txt", moving, moved)
	if err != nil || !strings.Contains(problem, "was changed") || !exists(root, "a.txt") {
		t.Fatalf("move after preflight = %q, %v", problem, err)
	}
}

func TestPrepareBlocksHardLinksAcrossMoves(t *testing.T) {
	root := t.TempDir()
	write(t, root, "Folder/a.txt", "a")
	if err := os.Link(filepath.Join(root, "Folder", "a.txt"), filepath.Join(root, "b.txt")); err != nil {
		t.Skip("hard links unsupported:", err)
	}
	p := Plan{Root: root, Moves: []Move{{From: "Folder", To: "Sorted/Folder"}, {From: "b.txt", To: "Sorted/b.txt"}}}
	if err := p.validate(); err != nil {
		t.Fatal(err)
	}
	vol, err := Mount(root)
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "plan.json")
	actions, err := Prepare(context.Background(), &p, vol, out)
	if err != nil {
		t.Fatal(err)
	}
	if a := actions[1]; a.Status != Blocked || !strings.Contains(a.Problem, "hard links") || exists(filepath.Dir(out), "plan.json") {
		t.Fatalf("prepare = %+v", actions)
	}
}

func TestOpenRefusesForeignJournalsAndSecondRuns(t *testing.T) {
	root := t.TempDir()
	write(t, root, "a.txt", "a")
	plan := prepare(t, root, Move{From: "a.txt", To: "b.txt"})

	journal := JournalPath(plan)
	write(t, filepath.Dir(journal), filepath.Base(journal), "not a journal")
	if _, err := Open(plan); err == nil || !strings.Contains(err.Error(), "no complete entry") {
		t.Fatalf("open with a foreign journal = %v", err)
	}
	if data, _ := os.ReadFile(journal); string(data) != "not a journal" {
		t.Fatalf("open changed the foreign file to %q", data)
	}

	if err := os.Remove(journal); err != nil {
		t.Fatal(err)
	}
	first := open(t, plan)
	if _, err := Open(plan); err == nil || !strings.Contains(err.Error(), "holds it") {
		t.Fatalf("second open = %v", err)
	}
	first.Close()
	open(t, plan).Close()
}

func TestUndoRemovesFoldersOnceEveryMoveIsBack(t *testing.T) {
	root := t.TempDir()
	write(t, root, "a.txt", "a")
	write(t, root, "b.txt", "b")
	plan := prepare(t, root, Move{From: "a.txt", To: "New/a.txt"}, Move{From: "b.txt", To: "New/b.txt"})
	run(t, plan, (*Run).Apply)

	write(t, root, "b.txt", "took the place meanwhile")
	if got := statuses(run(t, plan, (*Run).Undo)); !slices.Equal(got, []Status{Restored, Blocked}) {
		t.Fatalf("first undo = %v", got)
	}
	if err := os.Remove(filepath.Join(root, "b.txt")); err != nil {
		t.Fatal(err)
	}
	if got := statuses(run(t, plan, (*Run).Undo)); !slices.Equal(got, []Status{NotMoved, Restored}) {
		t.Fatalf("second undo = %v", got)
	}
	if exists(root, "New") {
		t.Fatal("undo left New, which apply made")
	}
	if err := os.Mkdir(filepath.Join(root, "New"), 0o700); err != nil {
		t.Fatal(err)
	}
	run(t, plan, (*Run).Undo)
	if !exists(root, "New") {
		t.Fatal("undo removed a New made after the moves were undone")
	}
}

func TestWithoutStableIDsApplyAndUndoCompareBytes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows reports the real file system's identity, and these temp folders keep stable IDs")
	}
	root := t.TempDir()
	write(t, root, "a.txt", "original")
	write(t, root, "b.txt", "b")
	plan := prepare(t, root, Move{From: "a.txt", To: "Sorted/a.txt"}, Move{From: "b.txt", To: "Sorted/b.txt"})
	r := open(t, plan)
	defer r.Close()
	r.vol.StableIDs = false
	// Same size and modified time: only the bytes tell the edit apart.
	rewrite(t, root, "a.txt", "OVERRIDE")
	res, err := r.Apply(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if a := res.Actions[0]; a.Status != Blocked || !strings.Contains(a.Problem, "holds other bytes") || !exists(root, "b.txt") {
		t.Fatalf("apply of an edited source = %+v", res.Actions)
	}
	rewrite(t, root, "a.txt", "original")
	if res, err := r.Apply(context.Background()); err != nil || res.Actions.Blocked() {
		t.Fatalf("apply = %+v, %v", res.Actions, err)
	}
	rewrite(t, root, "Sorted/a.txt", "OVERRIDE")

	res, err = r.Undo(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if a := res.Actions[0]; a.Status != Blocked || !strings.Contains(a.Problem, "holds other bytes") {
		t.Fatalf("edited move = %+v", a)
	}
	if res.Actions[1].Status != Restored || !exists(root, "b.txt") || !exists(root, "Sorted/a.txt") {
		t.Fatalf("undo = %+v", res.Actions)
	}
}

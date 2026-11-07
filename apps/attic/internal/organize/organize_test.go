package organize

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
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

// prepare saves a ready plan for moves below root and returns its path.
func prepare(t *testing.T, root string, moves ...Move) string {
	t.Helper()
	p := Plan{Root: root, Moves: moves}
	if err := p.validate(); err != nil {
		t.Fatal(err)
	}
	vol, err := Mount(root)
	if err != nil {
		t.Fatal(err)
	}
	actions, err := Prepare(context.Background(), &p, vol)
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range actions {
		if a.Status != Ready {
			t.Fatalf("move %d is %s: %s", a.Move, a.Status, a.Problem)
		}
	}
	path := filepath.Join(t.TempDir(), "plan.json")
	if err := Write(path, p); err != nil {
		t.Fatal(err)
	}
	return path
}

func run(t *testing.T, path string, cmd func(context.Context, *Plan, string, disk.Volume) (Result, error)) []Status {
	t.Helper()
	p, vol, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	res, err := cmd(context.Background(), &p, path, vol)
	if err != nil {
		t.Fatal(err)
	}
	statuses := make([]Status, len(res.Actions))
	for i, a := range res.Actions {
		statuses[i] = a.Status
	}
	return statuses
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
	p, _, err := Open(plan)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(NewFolders(p), ","); got != "Documents/School,Projects" {
		t.Fatalf("new folders = %s", got)
	}

	if got := run(t, plan, Apply); got[0] != Moved || got[1] != Moved {
		t.Fatalf("apply = %v", got)
	}
	for _, rel := range []string{"Documents/School/award.pdf", "Projects/Proj/src/logo.png", "Projects/Proj/empty"} {
		if !exists(root, rel) {
			t.Errorf("%s is missing after apply", rel)
		}
	}
	if got := run(t, plan, Apply); got[0] != AlreadyMoved || got[1] != AlreadyMoved {
		t.Fatalf("second apply = %v", got)
	}

	if got := run(t, plan, Undo); got[0] != Restored || got[1] != Restored {
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

func TestApplyMovesNothingWhenAnyActionIsBlocked(t *testing.T) {
	for _, tc := range []struct {
		name, want string
		change     func(root string)
	}{
		{"file written", "was written", func(root string) { write(t, root, "b.txt", "edited since prepare") }},
		{"file added to a folder", "was added", func(root string) { write(t, root, "Proj/new.txt", "new") }},
		{"destination taken", "already exists", func(root string) { write(t, root, "Sorted/b.txt", "other") }},
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
			tc.change(root)

			p, vol, err := Open(plan)
			if err != nil {
				t.Fatal(err)
			}
			res, err := Apply(context.Background(), &p, plan, vol)
			if err != nil {
				t.Fatal(err)
			}
			if !res.Blocked() || !strings.Contains(problems(res), tc.want) {
				t.Fatalf("apply did not block with %q: %+v", tc.want, res.Actions)
			}
			if !exists(root, "a.txt") || !exists(root, "Proj/logo.png") || exists(root, "Projects") {
				t.Fatal("apply moved something although an action was blocked")
			}
		})
	}
}

func problems(res Result) string {
	var all []string
	for _, a := range res.Actions {
		all = append(all, a.Problem)
	}
	return strings.Join(all, "\n")
}

func TestApplyResumesInterruptedMoves(t *testing.T) {
	root := t.TempDir()
	write(t, root, "a.txt", "a")
	write(t, root, "b.txt", "b")
	plan := prepare(t, root, Move{From: "a.txt", To: "a2.txt"}, Move{From: "b.txt", To: "b2.txt"})
	p, _, err := Open(plan)
	if err != nil {
		t.Fatal(err)
	}
	// The first run renamed a.txt but stopped before journalling it, and
	// stopped before renaming b.txt, halfway through writing a line.
	j, err := openJournal(JournalPath(plan), &p)
	if err != nil {
		t.Fatal(err)
	}
	for i := range 2 {
		if err := j.record(i, moving, ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := j.f.WriteString(`{"move":2,"fr`); err != nil {
		t.Fatal(err)
	}
	j.Close()
	if err := os.Rename(filepath.Join(root, "a.txt"), filepath.Join(root, "a2.txt")); err != nil {
		t.Fatal(err)
	}

	if got := run(t, plan, Apply); got[0] != AlreadyMoved || got[1] != Moved {
		t.Fatalf("resumed apply = %v", got)
	}
	if !exists(root, "a2.txt") || !exists(root, "b2.txt") || exists(root, "a.txt") || exists(root, "b.txt") {
		t.Fatal("resume did not finish both moves")
	}
	if got := run(t, plan, Apply); got[0] != AlreadyMoved || got[1] != AlreadyMoved {
		t.Fatalf("journal after resume = %v", got)
	}
}

func TestUndoWithoutStableIDsComparesBytesAndKeepsChangedMoves(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows reports the real file system's identity, and these temp folders keep stable IDs")
	}
	root := t.TempDir()
	write(t, root, "a.txt", "original")
	write(t, root, "b.txt", "b")
	plan := prepare(t, root, Move{From: "a.txt", To: "Sorted/a.txt"}, Move{From: "b.txt", To: "Sorted/b.txt"})
	p, vol, err := Open(plan)
	if err != nil {
		t.Fatal(err)
	}
	vol.StableIDs = false
	if _, err := Apply(context.Background(), &p, plan, vol); err != nil {
		t.Fatal(err)
	}
	// Same size and modified time: only the bytes tell the edit apart.
	moved := filepath.Join(root, "Sorted", "a.txt")
	info, err := os.Stat(moved)
	if err != nil {
		t.Fatal(err)
	}
	write(t, root, "Sorted/a.txt", "OVERRIDE")
	if err := os.Chtimes(moved, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}

	res, err := Undo(context.Background(), &p, plan, vol)
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

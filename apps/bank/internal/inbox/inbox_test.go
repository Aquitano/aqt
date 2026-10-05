package inbox

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/fail"
)

// drop writes a file into inbox/<kind>/ and returns its path. The mtime is
// backdated past the settle window, the way a real drop looks by the time a
// sweep runs.
func drop(t *testing.T, root, kind, name string) string {
	t.Helper()
	dir := filepath.Join(root, kind)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("payload"), 0o600); err != nil {
		t.Fatal(err)
	}
	settled := time.Now().Add(-2 * settleWindow)
	if err := os.Chtimes(p, settled, settled); err != nil {
		t.Fatal(err)
	}
	return p
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func TestSweepDispositions(t *testing.T) {
	root := t.TempDir()
	good := drop(t, root, "whatsapp", "good.zip")
	dupe := drop(t, root, "whatsapp", "already.zip")
	bad := drop(t, root, "eml", "broken.eml")
	drop(t, root, "eml", ".hidden.eml") // must be ignored

	route := func(_ context.Context, kind, path string) (Outcome, error) {
		switch filepath.Base(path) {
		case "good.zip":
			return Outcome{Inserted: 3}, nil
		case "already.zip":
			return Outcome{Duplicates: 3}, nil
		case "broken.eml":
			return Outcome{}, errors.New("not an email")
		}
		t.Fatalf("unexpected route(%s, %s)", kind, path)
		return Outcome{}, nil
	}

	res, err := Sweep(context.Background(), root, route)
	if err != nil {
		t.Fatal(err)
	}
	if res.Imported != 1 || res.Duplicates != 1 || res.Rejected != 1 || res.Failed != 0 {
		t.Fatalf("counts = %+v", res)
	}
	if len(res.Files) != 3 {
		t.Fatalf("hidden entries were swept: %+v", res.Files)
	}
	for _, p := range []string{good, dupe, bad} {
		if exists(p) {
			t.Errorf("%s was not filed away", p)
		}
	}
	if !exists(filepath.Join(root, doneDir, "whatsapp", "good.zip")) ||
		!exists(filepath.Join(root, doneDir, "whatsapp", "already.zip")) {
		t.Error("successful imports did not land in .done")
	}
	if !exists(filepath.Join(root, rejectedDir, "eml", "broken.eml")) {
		t.Error("a rejected file did not land in .rejected")
	}
	if !exists(filepath.Join(root, "eml", ".hidden.eml")) {
		t.Error("a hidden entry was moved")
	}
}

func TestSweepLeavesFilesAfterOperationalFailure(t *testing.T) {
	root := t.TempDir()
	stuck := drop(t, root, "whatsapp", "one.zip")
	later := drop(t, root, "whatsapp", "two.zip")

	calls := 0
	route := func(context.Context, string, string) (Outcome, error) {
		calls++
		return Outcome{}, fail.Opf("insert message: %w", errors.New("connection refused"))
	}

	res, err := Sweep(context.Background(), root, route)
	if err == nil {
		t.Fatal("an operational failure should surface")
	}
	if calls != 1 {
		t.Errorf("kept going after the database failed: %d calls", calls)
	}
	if res.Failed != 1 {
		t.Errorf("counts = %+v", res)
	}
	// Nothing about these files was wrong, so both stay put for the next run.
	if !exists(stuck) || !exists(later) {
		t.Error("files were filed away despite an operational failure")
	}
}

func TestSweepIsRetrySafe(t *testing.T) {
	root := t.TempDir()
	drop(t, root, "json", "notes.json")
	route := func(context.Context, string, string) (Outcome, error) {
		return Outcome{Inserted: 1}, nil
	}
	if _, err := Sweep(context.Background(), root, route); err != nil {
		t.Fatal(err)
	}
	// The same name arriving again must not overwrite the first one.
	drop(t, root, "json", "notes.json")
	if _, err := Sweep(context.Background(), root, route); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"notes.json", "notes-2.json"} {
		if !exists(filepath.Join(root, doneDir, "json", name)) {
			t.Errorf("%s missing from .done", name)
		}
	}
	// A second sweep of an empty drop zone does nothing at all.
	res, err := Sweep(context.Background(), root, route)
	if err != nil || len(res.Files) != 0 {
		t.Fatalf("res = %+v, err = %v", res, err)
	}
}

// A file whose mtime is fresh may still be copying in; sweeping it would
// import a truncation and archive it as the permanent raw copy.
func TestSweepLeavesFreshFilesToSettle(t *testing.T) {
	root := t.TempDir()
	fresh := drop(t, root, "mbox", "arriving.mbox")
	now := time.Now()
	if err := os.Chtimes(fresh, now, now); err != nil {
		t.Fatal(err)
	}
	res, err := Sweep(context.Background(), root, func(context.Context, string, string) (Outcome, error) {
		t.Fatal("a still-settling file was routed")
		return Outcome{}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Settling != 1 || len(res.Files) != 1 || res.Files[0].Disposition != Settling {
		t.Fatalf("res = %+v", res)
	}
	if !exists(fresh) {
		t.Error("a still-settling file was moved")
	}
}

func TestSweepIgnoresUnknownDirectories(t *testing.T) {
	root := t.TempDir()
	drop(t, root, "not-a-source", "x.txt")
	drop(t, root, doneDir, "x.txt")
	res, err := Sweep(context.Background(), root, func(context.Context, string, string) (Outcome, error) {
		t.Fatal("an unknown directory was routed")
		return Outcome{}, nil
	})
	if err != nil || len(res.Files) != 0 || len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0], "not-a-source") {
		t.Fatalf("res = %+v, err = %v", res, err)
	}
}

func TestSweepFilesAWhollyRejectedFileAsRejected(t *testing.T) {
	root := t.TempDir()
	drop(t, root, "json", "all-bad.json")
	route := func(context.Context, string, string) (Outcome, error) {
		// The file parsed, but every record in it was unusable.
		return Outcome{Rejected: 4}, nil
	}
	res, err := Sweep(context.Background(), root, route)
	if err != nil {
		t.Fatal(err)
	}
	if res.Rejected != 1 || res.Imported != 0 {
		t.Fatalf("counts = %+v", res)
	}
	if !exists(filepath.Join(root, rejectedDir, "json", "all-bad.json")) {
		t.Error("a file whose every record was rejected was filed as a success")
	}
}

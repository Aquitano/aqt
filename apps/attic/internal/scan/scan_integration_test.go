package scan

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/apps/attic/internal/storetest"
)

func write(t *testing.T, root, rel, body string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// scanAt runs a scan with the temporary folder standing in for a volume root,
// so the test needs neither a spare disk nor Windows.
func scanAt(t *testing.T, st *store.Store, root string, fp disk.Fingerprint) Result {
	t.Helper()
	res, err := Run(context.Background(), st, Options{
		Path:   root,
		locate: func(string) (disk.Volume, []string, error) { return disk.Volume{Fingerprint: fp, Root: root}, nil, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "complete" {
		t.Fatalf("status %q", res.Status)
	}
	return res
}

func find(t *testing.T, st *store.Store, query string) store.Hit {
	t.Helper()
	hits, err := st.Search(context.Background(), store.SearchOptions{Query: query})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 {
		t.Fatalf("search %q found nothing", query)
	}
	return hits[0]
}

func TestScanKeepsIdentityAcrossMoves(t *testing.T) {
	st, _ := storetest.New(t)
	ctx := context.Background()
	root := t.TempDir()
	write(t, root, "docs/Werkstudentenvertrag Element.pdf", "signed contract")
	write(t, root, "docs/copy.pdf", "signed contract")
	write(t, root, "photos/MinecraftServer.rar", "world")
	write(t, root, "projects/web/node_modules/x.js", "dependency")
	write(t, root, "notes.txt", "hello")
	fp := disk.Fingerprint{FS: "TEST", Serial: fmt.Sprintf("%X", time.Now().UnixNano()), Label: "Test", StableIDs: true}

	first := scanAt(t, st, root, fp)
	if first.Counts.Hashed != 4 || first.Counts.Duplicates != 1 {
		t.Fatalf("first scan hashed %d with %d duplicates, want 4 and 1", first.Counts.Hashed, first.Counts.Duplicates)
	}
	contract := find(t, st, "werkstudent")
	if contract.Path != "/docs/Werkstudentenvertrag Element.pdf" {
		t.Fatalf("fragment search found %s", contract.Path)
	}
	if hit := find(t, st, "minecraft"); hit.Path != "/photos/MinecraftServer.rar" {
		t.Fatalf("word search found %s", hit.Path)
	}
	dupes, _, err := st.Dupes(ctx, 0, false, 10)
	if err != nil || len(dupes) != 1 || dupes[0].Copies != 2 {
		t.Fatalf("dupes %+v, %v", dupes, err)
	}
	groups, err := st.SkipGroups(ctx, first.ScanID)
	if err != nil || len(groups) != 1 || groups[0].Example != "/projects/web/node_modules" {
		t.Fatalf("skips %+v, %v", groups, err)
	}

	notes := find(t, st, "notes")
	if err := os.Rename(filepath.Join(root, "docs"), filepath.Join(root, "papers")); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(root, "notes.txt"), filepath.Join(root, "renamed.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "papers", "copy.pdf")); err != nil {
		t.Fatal(err)
	}
	write(t, root, "photos/MinecraftServer.rar", "a bigger world")

	second := scanAt(t, st, root, fp)
	if second.Counts.Hashed != 1 {
		t.Errorf("second scan hashed %d files, want only the changed one", second.Counts.Hashed)
	}
	if moved := find(t, st, "werkstudent"); moved.ID != contract.ID || moved.Path != "/papers/Werkstudentenvertrag Element.pdf" {
		t.Errorf("file in a renamed folder: %+v, want id %d under /papers", moved, contract.ID)
	}
	if renamed := find(t, st, "renamed"); renamed.ID != notes.ID || renamed.Ref != notes.Ref {
		t.Errorf("renamed file: id %d ref %s, want id %d ref %s", renamed.ID, renamed.Ref, notes.ID, notes.Ref)
	}
	if gone := find(t, st, "copy"); !gone.Missing {
		t.Errorf("deleted file not marked missing: %+v", gone)
	}
	if second.Counts.Missing != 1 {
		t.Errorf("second scan missing %d, want 1", second.Counts.Missing)
	}
}

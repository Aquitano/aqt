package scan

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/apps/attic/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

func TestDirectoryReplacementMarksDescendantsMissing(t *testing.T) {
	for _, kind := range []string{"file", "link"} {
		t.Run(kind, func(t *testing.T) {
			st, dsn := storetest.New(t)
			root := t.TempDir()
			write(t, root, "replaced/nested/child.txt", "retained bytes")
			scanAt(t, st, root, testVolume)
			before := find(t, st, "child")
			if err := os.RemoveAll(filepath.Join(root, "replaced")); err != nil {
				t.Fatal(err)
			}
			if kind == "link" {
				if err := os.Symlink("elsewhere", filepath.Join(root, "replaced")); err != nil {
					t.Skipf("no symlinks: %v", err)
				}
			} else {
				write(t, root, "replaced", "now a file")
			}
			result := scanAt(t, st, root, testVolume)
			after, err := st.Entry(context.Background(), before.ID)
			if err != nil || !after.Missing || after.Ref != before.Ref || result.Counts.Missing != 2 {
				t.Fatalf("replacement: %+v, %v, counts %+v", after, err, result.Counts)
			}
			if n := pgschematest.QueryInt(t, dsn, "select count(*) from entries"); n != 4 {
				t.Fatalf("retained %d rows, want 4", n)
			}
		})
	}
}

func TestRawNamesKeepDistinctRowsAndParents(t *testing.T) {
	for name, stable := range map[string]bool{"path": false, "stable": true} {
		t.Run(name, func(t *testing.T) {
			st, dsn := storetest.New(t)
			root := t.TempDir()
			names := []string{"bad\xed\xa0\x80", "bad\xed\xa0\x81"}
			for _, name := range names {
				if err := os.Mkdir(filepath.Join(root, name), 0o755); err != nil {
					t.Skipf("no raw names: %v", err)
				}
				write(t, root, name+"/child.txt", "child")
				write(t, root, name+".bin", "file")
			}
			fp := testVolume
			fp.StableIDs = stable
			first := scanAt(t, st, root, fp)
			second := scanAt(t, st, root, fp)
			if first.Counts.Listed != 7 || second.Counts.Written != 0 || second.Counts.Missing != 0 {
				t.Fatalf("first %+v, second %+v", first.Counts, second.Counts)
			}
			for _, name := range names {
				if n := pgschematest.QueryInt(t, dsn, `select count(*) from entries child join entries parent on child.parent_id=parent.id where parent.raw_name=$1 and child.name='child.txt' and child.missing_scan is null`, []byte(name)); n != 1 {
					t.Fatalf("%q has %d children", name, n)
				}
				if n := pgschematest.QueryInt(t, dsn, `select count(*) from entries where raw_name=$1 and kind='file' and missing_scan is null`, []byte(name+".bin")); n != 1 {
					t.Fatalf("%q has %d file rows", name, n)
				}
			}
			if err := os.Remove(filepath.Join(root, names[0], "child.txt")); err != nil {
				t.Fatal(err)
			}
			scanAt(t, st, root, fp)
			if n := pgschematest.QueryInt(t, dsn, `select count(*) from entries child join entries parent on child.parent_id=parent.id where parent.raw_name=$1 and child.missing_scan is null`, []byte(names[1])); n != 1 {
				t.Fatalf("other directory lost its child: %d", n)
			}
		})
	}
}

func TestHardLinksReuseContentAcrossInitialNewAndChangedLinks(t *testing.T) {
	st, _ := storetest.New(t)
	root := t.TempDir()
	write(t, root, "a/linked.bin", "original")
	if err := os.Mkdir(filepath.Join(root, "b"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := func(name string) {
		t.Helper()
		if err := os.Link(filepath.Join(root, "a/linked.bin"), filepath.Join(root, name)); err != nil {
			t.Skipf("no hardlinks: %v", err)
		}
	}
	link("b/linked.bin")
	observed, err := disk.Stat(filepath.Join(root, "a/linked.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if observed.Changed.IsZero() {
		t.Skip("this platform does not report change time")
	}
	var previousRef string
	for _, phase := range []string{"initial", "new", "changed"} {
		switch phase {
		case "new":
			link("linked-new.bin")
		case "changed":
			info, err := os.Stat(filepath.Join(root, "a/linked.bin"))
			if err != nil {
				t.Fatal(err)
			}
			write(t, root, "a/linked.bin", "modified")
			if err := os.Chtimes(filepath.Join(root, "a/linked.bin"), info.ModTime(), info.ModTime()); err != nil {
				t.Fatal(err)
			}
		}
		result := scanAt(t, st, root, testVolume)
		if result.Counts.Hashed != 1 {
			t.Fatalf("%s: hashed %d files, want one physical read", phase, result.Counts.Hashed)
		}
		hits, err := st.Search(context.Background(), store.SearchOptions{Query: "linked"})
		if err != nil {
			t.Fatal(err)
		}
		if len(hits) < 2 {
			t.Fatalf("%s: missing links: %+v", phase, hits)
		}
		if phase == "changed" && hits[0].Ref == previousRef {
			t.Fatalf("changed hardlink kept old content %s", previousRef)
		}
		previousRef = hits[0].Ref
		for _, hit := range hits {
			if hit.Ref == "" || hit.Ref != hits[0].Ref {
				t.Fatalf("%s: inconsistent content: %+v", phase, hits)
			}
		}
		if again := scanAt(t, st, root, testVolume); again.Counts.Hashed != 0 {
			t.Fatalf("%s rescan hashed %d", phase, again.Counts.Hashed)
		}
	}
}

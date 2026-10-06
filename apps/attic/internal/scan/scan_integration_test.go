package scan

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/config"
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

// testVolume stands in for a disk; every test has a schema of its own.
var testVolume = disk.Fingerprint{FS: "TEST", Serial: "7E57", Label: "Test", StableIDs: true}

// scanAt runs a scan with the temporary folder standing in for a volume root,
// so the test needs neither a spare disk nor Windows.
func scanAt(t *testing.T, st *store.Store, root string, fp disk.Fingerprint, with ...func(*Options)) Result {
	t.Helper()
	o := Options{
		Path:   root,
		locate: func(string) (disk.Volume, []string, error) { return disk.Volume{Fingerprint: fp, Root: root}, nil, nil },
	}
	for _, f := range with {
		f(&o)
	}
	res, err := Run(context.Background(), st, o)
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
	excluded := slices.IndexFunc(groups, func(g store.SkipGroup) bool { return g.Reason == "excluded" })
	if err != nil || excluded < 0 || groups[excluded].Count != 1 || groups[excluded].Example != "/projects/web/node_modules" {
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

func TestDeletedFolderTakesItsFilesAlong(t *testing.T) {
	st, _ := storetest.New(t)
	root := t.TempDir()
	write(t, root, "old/report.txt", "quarterly")
	write(t, root, "old/sub/deep.txt", "quarterly")
	write(t, root, "keep.txt", "quarterly")
	scanAt(t, st, root, testVolume)
	if err := os.RemoveAll(filepath.Join(root, "old")); err != nil {
		t.Fatal(err)
	}

	res := scanAt(t, st, root, testVolume)
	if res.Counts.Missing != 4 {
		t.Errorf("missing %d, want the folder, its subfolder and both files", res.Counts.Missing)
	}
	if hit := find(t, st, "deep"); !hit.Missing {
		t.Errorf("a file two levels below a deleted folder still reads as present: %+v", hit)
	}
	if dupes, _, err := st.Dupes(context.Background(), 0, false, 10); err != nil || len(dupes) != 0 {
		t.Errorf("deleted copies still count as duplicates: %+v, %v", dupes, err)
	}
}

// A backup rotation: Latest becomes Old/2025 and Staging takes Latest's name,
// so the old path of one folder is now another folder's.
func TestRotatedFoldersKeepTheirFiles(t *testing.T) {
	st, _ := storetest.New(t)
	root := t.TempDir()
	write(t, root, "Data/Latest/monday.txt", "monday")
	write(t, root, "Data/Staging/tuesday.txt", "tuesday")
	scanAt(t, st, root, testVolume)
	if err := os.MkdirAll(filepath.Join(root, "Old"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, mv := range [][2]string{{"Data/Latest", "Old/2025"}, {"Data/Staging", "Data/Latest"}} {
		if err := os.Rename(filepath.Join(root, filepath.FromSlash(mv[0])), filepath.Join(root, filepath.FromSlash(mv[1]))); err != nil {
			t.Fatal(err)
		}
	}

	res := scanAt(t, st, root, testVolume)
	if res.Counts.Hashed != 0 || res.Counts.Missing != 0 {
		t.Errorf("rotation hashed %d and lost %d, want nothing either way", res.Counts.Hashed, res.Counts.Missing)
	}
	for query, want := range map[string]string{"monday": "/Old/2025/monday.txt", "tuesday": "/Data/Latest/tuesday.txt"} {
		if hit := find(t, st, query); hit.Path != want || hit.Missing {
			t.Errorf("%s: %s (missing %v), want %s", query, hit.Path, hit.Missing, want)
		}
	}
}

func TestExclusionAddedAfterListingStopsHashing(t *testing.T) {
	st, _ := storetest.New(t)
	root := t.TempDir()
	write(t, root, "disk.iso", "image")
	write(t, root, "notes.txt", "notes")
	scanAt(t, st, root, testVolume, func(o *Options) { o.NoHash = true })

	res := scanAt(t, st, root, testVolume, func(o *Options) { o.Config = config.Config{Exclude: []string{"*.iso"}} })
	if res.Counts.Hashed != 1 {
		t.Errorf("hashed %d files, want only notes.txt", res.Counts.Hashed)
	}
	if iso := find(t, st, "disk"); iso.Ref != "" {
		t.Errorf("an excluded file was read: %+v", iso)
	}
}

// The second of two hard links in a folder keeps its path as identity. Once
// the first is gone and created again, the scan must still match both.
func TestReappearingHardLinkScans(t *testing.T) {
	st, _ := storetest.New(t)
	root := t.TempDir()
	a, b := filepath.Join(root, "a.txt"), filepath.Join(root, "b.txt")
	write(t, root, "a.txt", "linked")
	if err := os.Link(a, b); err != nil {
		t.Skipf("no hard links here: %v", err)
	}
	scanAt(t, st, root, testVolume)
	if err := os.Remove(a); err != nil {
		t.Fatal(err)
	}
	scanAt(t, st, root, testVolume)
	if err := os.Link(b, a); err != nil {
		t.Fatal(err)
	}
	scanAt(t, st, root, testVolume)
	scanAt(t, st, root, testVolume)
}

func zipOf(t *testing.T, files map[string]string) string {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, name := range slices.Sorted(maps.Keys(files)) {
		w, err := zw.Create(name)
		if err == nil {
			_, err = w.Write([]byte(files[name]))
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.String()
}

// Two copies of one backup zip are read once, and a hit inside it names both.
// Once both copies are rewritten, the old listing is no longer found.
func TestArchivesAreListedOncePerContent(t *testing.T) {
	st, _ := storetest.New(t)
	ctx := context.Background()
	root := t.TempDir()
	server := zipOf(t, map[string]string{"server.properties": "motd=hi", "deeper.zip": zipOf(t, map[string]string{"x.txt": "x"})})
	backup := zipOf(t, map[string]string{"world/level.dat": "level", "MinecraftServer.zip": server})
	write(t, root, "Backups/Minecraft.zip", backup)
	write(t, root, "Old/Minecraft copy.zip", backup)
	// A tar header can carry a year Postgres cannot store.
	write(t, root, "Backups/odd.tar", tarOf(t, "future.txt", time.Date(300_000, 1, 1, 0, 0, 0, 0, time.UTC)))
	withArchives := func(o *Options) { o.Config = config.Default() }

	first := scanAt(t, st, root, testVolume, withArchives)
	if first.Counts.Archives != 2 || first.Counts.Members != 5 {
		t.Fatalf("listed %d archives with %d members, want 2 with 5", first.Counts.Archives, first.Counts.Members)
	}
	hits, err := st.SearchMembers(ctx, store.SearchOptions{Query: "server properties"})
	if err != nil || len(hits) != 1 {
		t.Fatalf("members %+v, %v", hits, err)
	}
	if hits[0].Path != "MinecraftServer.zip :: server.properties" || len(hits[0].Archive) != 2 {
		t.Errorf("hit %s in %d copies, want the nested path in both", hits[0].Path, len(hits[0].Archive))
	}
	skips, err := st.Skips(ctx, first.ScanID, "too_deep", "", 10)
	if err != nil || len(skips) != 1 || skips[0].Path != "/Backups/Minecraft.zip :: MinecraftServer.zip :: deeper.zip" {
		t.Errorf("too_deep skips %+v, %v", skips, err)
	}

	if again := scanAt(t, st, root, testVolume, withArchives); again.Counts.Archives != 0 {
		t.Errorf("a rescan listed %d archives again", again.Counts.Archives)
	}

	rewritten := zipOf(t, map[string]string{"world/level.dat": "a newer level"})
	write(t, root, "Backups/Minecraft.zip", rewritten)
	write(t, root, "Old/Minecraft copy.zip", rewritten)
	scanAt(t, st, root, testVolume, withArchives)
	if hits, err := st.SearchMembers(ctx, store.SearchOptions{Query: "server properties"}); err != nil || len(hits) != 0 {
		t.Errorf("members of a rewritten archive still found: %+v, %v", hits, err)
	}
}

func tarOf(t *testing.T, name string, modified time.Time) string {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, ModTime: modified, Format: tar.FormatPAX}); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.String()
}

// Documents are read once per content and found by their words; configuration
// keeps its name only, and text past the cap is kept and marked.
func TestDocumentsAreReadForTheirWords(t *testing.T) {
	st, _ := storetest.New(t)
	ctx := context.Background()
	root := t.TempDir()
	write(t, root, "Verträge/Werkstudent.txt", "Arbeitszeit zwanzig Stunden pro Woche")
	write(t, root, "Backup/Werkstudent copy.txt", "Arbeitszeit zwanzig Stunden pro Woche")
	write(t, root, "project/settings.json", `{"note": "Stunden pro Woche"}`)
	write(t, root, "long.md", strings.Repeat("lang ", 300_000))
	// Too short for the PDF reader: a broken file, not a disk error.
	write(t, root, "stub.pdf", "%PDF-1.4")

	res := scanAt(t, st, root, testVolume)
	if res.Counts.Texts != 3 {
		t.Fatalf("read %d documents, want the contract once, long.md and stub.pdf", res.Counts.Texts)
	}
	if failed, err := st.Skips(ctx, res.ScanID, "text_failed", "", 10); err != nil || len(failed) != 1 {
		t.Errorf("text_failed skips %+v, %v; want stub.pdf", failed, err)
	}
	hits, err := st.SearchTexts(ctx, store.SearchOptions{Query: "stunden woche"})
	if err != nil || len(hits) != 1 {
		t.Fatalf("text hits %+v, %v; want only the contract, not settings.json", hits, err)
	}
	if len(hits[0].Places) != 2 || !strings.Contains(hits[0].Snippet, "Stunden") {
		t.Errorf("hit %+v, want both copies and a snippet with the words", hits[0])
	}
	long, err := st.Text(ctx, find(t, st, "long").ID, "")
	if err != nil || long.Status != "truncated" || long.Chars > 1<<20 {
		t.Errorf("long.md: %s with %d characters, %v; want truncated at the cap", long.Status, long.Chars, err)
	}
}

// The size cap is a skip, not a property of the content: raising it reads the
// document on the next scan.
func TestOversizedDocumentsWaitForTheCap(t *testing.T) {
	st, _ := storetest.New(t)
	root := t.TempDir()
	write(t, root, "report.txt", "quarterly figures for the board")
	capped := func(o *Options) { o.Config.Text.MaxBytes = 10 }

	first := scanAt(t, st, root, testVolume, capped)
	skips, err := st.Skips(context.Background(), first.ScanID, "too_big", "", 10)
	if first.Counts.Texts != 0 || err != nil || len(skips) != 1 {
		t.Fatalf("read %d documents with skips %+v, %v; want none read and report.txt too big", first.Counts.Texts, skips, err)
	}
	if again := scanAt(t, st, root, testVolume); again.Counts.Texts != 1 {
		t.Errorf("without the cap read %d documents, want report.txt", again.Counts.Texts)
	}
}

// A scan's log tells its story: the start, each phase with its time and
// counts, each document at debug, the end. The phase times reach the history.
func TestScanLogsItsPhases(t *testing.T) {
	st, _ := storetest.New(t)
	root := t.TempDir()
	write(t, root, "notes.txt", "meeting notes")
	var buf bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	res := scanAt(t, st, root, testVolume, func(o *Options) { o.Log = log })

	var messages []string
	for line := range strings.Lines(buf.String()) {
		var rec struct {
			Msg  string `json:"msg"`
			Scan int64  `json:"scan"`
		}
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("not a JSON record: %q", line)
		}
		if rec.Scan != res.ScanID {
			t.Errorf("record %q carries scan %d, want %d", rec.Msg, rec.Scan, res.ScanID)
		}
		messages = append(messages, rec.Msg)
	}
	for _, want := range []string{"scan started", "phase finished", "file hashed", "document read", "scan finished"} {
		if !slices.Contains(messages, want) {
			t.Errorf("no %q record in %q", want, messages)
		}
	}
	history, err := st.Scans(context.Background(), "", 1)
	if err != nil || len(history) != 1 || res.Phases.Hash == 0 || history[0].Phases.Hash != res.Phases.Hash.Truncate(time.Millisecond) {
		t.Errorf("history %+v, %v; want the scan with its phase times, in milliseconds, %+v", history, err, res.Phases)
	}
}

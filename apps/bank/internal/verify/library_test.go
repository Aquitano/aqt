package verify

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestLibraryFileIntegrityWithoutInventedHealing(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	root := t.TempDir()
	blobs, err := blob.New(filepath.Join(root, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	batch := library.ImportBatch{Version: 1}
	expected := map[string]string{}
	for _, scenario := range []string{"healthy", MissingBlob, CorruptBlob, WrongSize} {
		sum, size, err := blobs.Put(strings.NewReader("library file: " + scenario))
		if err != nil {
			t.Fatal(err)
		}
		file := library.File{Identity: library.Identity{Source: "library-test", Account: "owner", ExternalID: scenario}, SHA256: sum, SizeBytes: size, Filename: scenario + ".txt", MimeType: "text/plain"}
		switch scenario {
		case MissingBlob:
			if err := os.Remove(blobs.Path(sum)); err != nil {
				t.Fatal(err)
			}
		case CorruptBlob:
			if err := os.WriteFile(blobs.Path(sum), []byte("changed"), 0600); err != nil {
				t.Fatal(err)
			}
		case WrongSize:
			file.SizeBytes++
		}
		if scenario != "healthy" {
			expected[library.StableID("file", file.Identity)] = scenario
		}
		batch.Files = append(batch.Files, file)
	}
	if _, err := st.ImportLibrary(ctx, batch); err != nil {
		t.Fatal(err)
	}
	for _, heal := range []bool{false, true} {
		report, err := Run(ctx, st, blobs, filepath.Join(root, "archive"), Options{Heal: heal})
		if err != nil {
			t.Fatal(err)
		}
		if report.LibraryFilesChecked != 4 || report.LibraryRecordsChecked != 4 || report.Damaged != 3 || report.Repaired != 0 || report.Unrecoverable != 3 {
			t.Fatalf("heal=%t: %+v", heal, report)
		}
		for _, finding := range report.Findings {
			if expected[finding.LibraryID] != finding.Kind || finding.LibraryKind != "file" || finding.Repaired {
				t.Fatalf("unexpected finding: %+v", finding)
			}
		}
	}
	report, err := Run(ctx, st, blobs, filepath.Join(root, "archive"), Options{Source: "another-source"})
	if err != nil || report.LibraryRecordsChecked != 0 {
		t.Fatalf("source filter: %+v %v", report, err)
	}
}

func TestLibraryProvenanceIncludesOlderSnapshots(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	root := t.TempDir()
	blobs, err := blob.New(filepath.Join(root, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	archiveDir := filepath.Join(root, "archive")
	raw := []byte("source export")
	ref, err := archive.Write(archiveDir, "library-test", hashBytes(raw)+"-export.json", raw)
	if err != nil {
		t.Fatal(err)
	}
	item := library.Item{Identity: library.Identity{Source: "library-test", Account: "owner", ExternalID: "video"}, Kind: "video", Title: "Example", Provenance: library.Provenance{RawRef: ref}}
	collection := library.Collection{Identity: library.Identity{Source: "library-test", Account: "owner", ExternalID: "playlist"}, Kind: "playlist", Title: "Example playlist", Snapshot: &library.Snapshot{ExternalID: "older", Captured: library.Date{Precision: "unknown"}, Completeness: "complete", Provenance: library.Provenance{RawRef: "library-test/missing.json"}}}
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{item}, Collections: []library.Collection{collection}}); err != nil {
		t.Fatal(err)
	}
	collection.Snapshot = &library.Snapshot{ExternalID: "newer", Captured: library.Date{Precision: "unknown"}, Completeness: "complete", Provenance: library.Provenance{RawRef: ref}}
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Collections: []library.Collection{collection}}); err != nil {
		t.Fatal(err)
	}
	report, err := Run(ctx, st, blobs, archiveDir, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if report.LibraryRecordsChecked != 3 || report.Damaged != 1 || report.Findings[0].Kind != MissingRaw || !strings.Contains(report.Findings[0].Detail, "snapshot older") {
		t.Fatalf("older snapshot not checked: %+v", report)
	}
	if err := os.WriteFile(filepath.Join(archiveDir, filepath.FromSlash(ref)), []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	report, err = Run(ctx, st, blobs, archiveDir, Options{Heal: true})
	if err != nil {
		t.Fatal(err)
	}
	if kinds(report)[CorruptRaw] != 2 || report.Repaired != 0 {
		t.Fatalf("corrupt source not reported for both records: %+v", report)
	}
}

func TestLibraryVerificationRetainsOlderItemEvidence(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	old, err := archive.Write(f.archiveDir, "library-test", "older.json", []byte("older source"))
	if err != nil {
		t.Fatal(err)
	}
	item := library.Item{Identity: library.Identity{Source: "library-test", Account: "owner", ExternalID: "video"}, Kind: "video", Title: "Example", Provenance: library.Provenance{RawRef: old}}
	if _, err := f.st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{item}}); err != nil {
		t.Fatal(err)
	}
	latest, err := archive.Write(f.archiveDir, "library-test", "latest.json", []byte("latest source"))
	if err != nil {
		t.Fatal(err)
	}
	item.Provenance.RawRef = latest
	if _, err := f.st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{item}}); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(f.archiveDir, filepath.FromSlash(old))); err != nil {
		t.Fatal(err)
	}
	report, err := Run(ctx, f.st, f.blobs, f.archiveDir, Options{Source: "library-test"})
	if err != nil {
		t.Fatal(err)
	}
	if report.LibraryRecordsChecked != 1 || report.Damaged != 1 || report.Findings[0].Kind != MissingRaw || report.Findings[0].Detail != old {
		t.Fatalf("older item evidence not verified: %+v", report)
	}
}

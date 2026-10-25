package dedupe

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"lukechampine.com/blake3"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/store"
)

type recorder struct {
	moves []store.DedupeMove
	fail  bool
	// meanwhile runs while a move is being recorded.
	meanwhile func()
}

func (r *recorder) RecordDedupeMove(_ context.Context, m store.DedupeMove) error {
	if r.meanwhile != nil {
		r.meanwhile()
	}
	if r.fail {
		return errors.New("catalogue unavailable")
	}
	r.moves = append(r.moves, m)
	return nil
}

func write(t *testing.T, root, rel string, data []byte) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// mount describes root as an attached disk. On Windows it carries the real
// fingerprint, which Apply checks before each move.
func mount(t *testing.T, root string) disk.Volume {
	t.Helper()
	m := disk.Volume{}
	if runtime.GOOS == "windows" {
		var err error
		if m, _, err = disk.Locate(root); err != nil {
			t.Fatal(err)
		}
	}
	m.Root = root
	return m
}

func group(content []byte, kept, extra store.Hit) store.DedupeGroup {
	extra.Size = int64(len(content))
	return store.DedupeGroup{
		ContentID: 7, Digest: blake3.Sum256(content), Ref: "0123456789abcdef", Size: int64(len(content)),
		Kept: []store.Hit{kept}, Extra: []store.Hit{extra},
	}
}

func TestApplyMovesOnlyVerifiedExtraCopies(t *testing.T) {
	content := []byte("the 2017 server code")
	for _, tc := range []struct {
		name          string
		kept, extra   []byte
		failRecording bool
		wantMoved     bool
	}{
		{name: "both copies match", kept: content, extra: content, wantMoved: true},
		{name: "extra copy changed", kept: content, extra: []byte("edited since the scan")},
		{name: "kept copy changed", kept: []byte("edited since the scan"), extra: content},
		{name: "move cannot be recorded", kept: content, extra: content, failRecording: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			keptRoot, extraRoot := t.TempDir(), t.TempDir()
			write(t, keptRoot, "Files/server.zip", tc.kept)
			write(t, extraRoot, "Backup/server.zip", tc.extra)
			g := group(content, store.Hit{ID: 1, VolumeID: "kept", Path: "/Files/server.zip"},
				store.Hit{ID: 2, VolumeID: "extra", Path: "/Backup/server.zip"})
			rec := &recorder{fail: tc.failRecording}
			res, err := Apply(t.Context(), rec, []store.DedupeGroup{g}, map[string]disk.Volume{"kept": mount(t, keptRoot), "extra": mount(t, extraRoot)}, "run")

			original := filepath.Join(extraRoot, "Backup", "server.zip")
			quarantined := filepath.Join(extraRoot, Quarantine, "run", "Backup", "server.zip")
			if tc.failRecording {
				if err == nil {
					t.Fatal("an unrecorded move succeeded")
				}
				if _, statErr := os.Stat(original); statErr != nil {
					t.Fatalf("the copy did not go back after the record failed: %v", statErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !tc.wantMoved {
				if len(res.Moved) != 0 || len(res.Skipped) != 1 || len(rec.moves) != 0 {
					t.Fatalf("result = %+v, recorded %+v", res, rec.moves)
				}
				if got, _ := os.ReadFile(original); !bytes.Equal(got, tc.extra) {
					t.Fatal("a skipped copy was touched")
				}
				return
			}
			if len(res.Moved) != 1 || res.Bytes != int64(len(content)) || len(rec.moves) != 1 || rec.moves[0].KeptEntryID != 1 || rec.moves[0].MovedTo != quarantined {
				t.Fatalf("result = %+v, recorded %+v", res, rec.moves)
			}
			if _, err := os.Stat(original); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("the extra copy is still in place: %v", err)
			}
			if got, err := os.ReadFile(quarantined); err != nil || !bytes.Equal(got, content) {
				t.Fatalf("quarantined copy = %q, %v", got, err)
			}
		})
	}
}

func TestApplyLeavesTheCopyInQuarantineWhenItsPathWasTaken(t *testing.T) {
	content := []byte("the 2017 server code")
	root := t.TempDir()
	write(t, root, "Files/server.zip", content)
	write(t, root, "Backup/server.zip", content)
	original := filepath.Join(root, "Backup", "server.zip")
	saved := []byte("saved there while the move was recorded")
	rec := &recorder{fail: true, meanwhile: func() { write(t, root, "Backup/server.zip", saved) }}
	g := group(content, store.Hit{ID: 1, VolumeID: "data", Path: "/Files/server.zip"},
		store.Hit{ID: 2, VolumeID: "data", Path: "/Backup/server.zip"})

	if _, err := Apply(t.Context(), rec, []store.DedupeGroup{g}, map[string]disk.Volume{"data": mount(t, root)}, "run"); err == nil {
		t.Fatal("an unrecorded move succeeded")
	}
	if got, _ := os.ReadFile(original); !bytes.Equal(got, saved) {
		t.Fatalf("the undo overwrote the new file: %q", got)
	}
	if got, _ := os.ReadFile(filepath.Join(root, Quarantine, "run", "Backup", "server.zip")); !bytes.Equal(got, content) {
		t.Fatalf("quarantined copy = %q", got)
	}
}

func TestApplyLeavesADiskThatTwoVolumesClaim(t *testing.T) {
	content := []byte("the 2017 server code")
	root := t.TempDir()
	write(t, root, "Files/server.zip", content)
	// Two clones without a device serial: both catalogue volumes match the one
	// attached disk, so the extra entry is the kept file itself.
	g := group(content, store.Hit{ID: 1, VolumeID: "original", Path: "/Files/server.zip"},
		store.Hit{ID: 2, VolumeID: "clone", Path: "/Files/server.zip"})

	m := mount(t, root)
	res, err := Apply(t.Context(), &recorder{}, []store.DedupeGroup{g}, map[string]disk.Volume{"original": m, "clone": m}, "run")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Moved) != 0 || len(res.Skipped) != 1 {
		t.Fatalf("result = %+v", res)
	}
	if _, err := os.Stat(filepath.Join(root, "Files", "server.zip")); err != nil {
		t.Fatalf("the kept file moved: %v", err)
	}
}

func TestApplyStopsMovingWhenTheKeptCopyChanges(t *testing.T) {
	content := []byte("the 2017 server code")
	root := t.TempDir()
	write(t, root, "Files/server.zip", content)
	write(t, root, "Backup/a.zip", content)
	write(t, root, "Backup/b.zip", content)
	g := group(content, store.Hit{ID: 1, VolumeID: "data", Path: "/Files/server.zip"},
		store.Hit{ID: 2, VolumeID: "data", Path: "/Backup/a.zip"})
	g.Extra = append(g.Extra, store.Hit{ID: 3, VolumeID: "data", Path: "/Backup/b.zip", Size: int64(len(content))})
	rec := &recorder{meanwhile: func() { write(t, root, "Files/server.zip", []byte("edited during the run")) }}

	res, err := Apply(t.Context(), rec, []store.DedupeGroup{g}, map[string]disk.Volume{"data": mount(t, root)}, "run")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Moved) != 1 || len(res.Skipped) != 1 || res.Skipped[0].EntryID != 3 {
		t.Fatalf("result = %+v; the copy after the kept copy changed must stay", res)
	}
}

func TestApplyReportsCancellationInTheLastGroup(t *testing.T) {
	content := []byte("the 2017 server code")
	root := t.TempDir()
	write(t, root, "Files/server.zip", content)
	write(t, root, "Backup/server.zip", content)
	ctx, cancel := context.WithCancel(t.Context())
	g := group(content, store.Hit{ID: 1, VolumeID: "data", Path: "/Files/server.zip"},
		store.Hit{ID: 2, VolumeID: "data", Path: "/Backup/server.zip"})

	if _, err := Apply(ctx, &recorder{meanwhile: cancel}, []store.DedupeGroup{g}, map[string]disk.Volume{"data": mount(t, root)}, "run"); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want the cancellation", err)
	}
}

func TestStillHashedAcceptsOnlyTheHashedBytes(t *testing.T) {
	content := []byte("the 2017 server code")
	root := t.TempDir()
	write(t, root, "server.zip", content)
	digest, hashed, err := disk.HashOrdinaryInfo(t.Context(), root, "server.zip")
	if err != nil {
		t.Fatal(err)
	}
	write(t, root, "copy.zip", content)
	write(t, root, "edited.zip", []byte("the 2017 server cod3"))
	for _, name := range []string{"copy.zip", "edited.zip"} {
		if err := os.Chtimes(filepath.Join(root, name), hashed.ModTime(), hashed.ModTime()); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		rel       string
		stableIDs bool
		want      bool
	}{
		{"server.zip", true, true},
		// On FAT and exFAT a moved file has a new ID but the same bytes and times.
		{"copy.zip", false, true},
		{"copy.zip", true, false},
		{"edited.zip", false, false},
	} {
		if got := stillHashed(t.Context(), root, tc.rel, hashed, digest, tc.stableIDs); got != tc.want {
			t.Errorf("stillHashed(%s, stable IDs %v) = %v, want %v", tc.rel, tc.stableIDs, got, tc.want)
		}
	}
}

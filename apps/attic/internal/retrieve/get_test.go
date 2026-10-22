package retrieve

import (
	"context"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/config"
	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/scratch"
	"github.com/aquitano/aqt/apps/attic/internal/store"
	"lukechampine.com/blake3"
)

func TestVerifiedCopySelection(t *testing.T) {
	for _, tc := range []struct {
		name     string
		sources  []string
		mismatch bool
		wantErr  error
	}{
		{name: "success", sources: []string{"original"}},
		{name: "fallback", sources: []string{"missing", "modified", "original"}},
		{name: "read failure", sources: []string{"missing"}, wantErr: os.ErrNotExist},
		{name: "full digest mismatch", sources: []string{"original"}, mismatch: true, wantErr: scratch.ErrChanged},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, destDir := t.TempDir(), t.TempDir()
			content := store.Retrieval{Digest: blake3.Sum256([]byte("original")), Size: 8}
			if tc.mismatch {
				content.Digest[31] ^= 1
			}
			content.Ref = hex.EncodeToString(content.Digest[:8])
			for i, data := range tc.sources {
				if data != "missing" {
					if err := os.WriteFile(filepath.Join(root, data), []byte(data), 0600); err != nil {
						t.Fatal(err)
					}
				}
				content.Places = append(content.Places, store.Hit{ID: int64(i + 1), VolumeID: "v", Path: data})
			}
			dest := filepath.Join(destDir, "recovered")
			got, err := copyCandidates(t.Context(), content, dest, content.Places, nil, func(p store.Hit) (*os.File, error) { return disk.OpenOrdinary(root, p.Path) })
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("error = %v, want %v", err, tc.wantErr)
				}
				if _, err := os.Lstat(dest); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("destination survived: %v", err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				if data, err := os.ReadFile(dest); err != nil || string(data) != "original" {
					t.Fatalf("destination %q: %v", data, err)
				}
				if got.EntryID != int64(len(tc.sources)) || got.Blake3 != hex.EncodeToString(content.Digest[:]) {
					t.Fatalf("result: %+v", got)
				}
				if data, err := os.ReadFile(filepath.Join(root, "original")); err != nil || string(data) != "original" {
					t.Fatalf("source %q: %v", data, err)
				}
			}
			entries, err := os.ReadDir(destDir)
			if err != nil {
				t.Fatal(err)
			}
			for _, e := range entries {
				if e.Name() != "recovered" {
					t.Fatalf("temporary output remains: %s", e.Name())
				}
			}
		})
	}
}

func TestDestinationFailuresDoNotRetrySources(t *testing.T) {
	for _, concurrent := range []bool{false, true} {
		t.Run(map[bool]string{false: "existing", true: "concurrent"}[concurrent], func(t *testing.T) {
			root := t.TempDir()
			dest := filepath.Join(t.TempDir(), "recovered")
			if err := os.WriteFile(filepath.Join(root, "source"), []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			content := store.Retrieval{Digest: blake3.Sum256([]byte("original")), Size: 8, Places: []store.Hit{{ID: 1}, {ID: 2}}}
			if !concurrent {
				if err := os.WriteFile(dest, []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
				if _, err := Get(t.Context(), content, dest, nil, nil, config.Config{}); !errors.Is(err, os.ErrExist) {
					t.Fatalf("existing: %v", err)
				}
			} else {
				calls := 0
				_, err := copyCandidates(t.Context(), content, dest, content.Places, nil, func(store.Hit) (*os.File, error) {
					calls++
					if err := os.WriteFile(dest, []byte("keep"), 0600); err != nil {
						t.Fatal(err)
					}
					return disk.OpenOrdinary(root, "source")
				})
				if err == nil || calls != 1 {
					t.Fatalf("publication failure: calls=%d err=%v", calls, err)
				}
			}
			if data, err := os.ReadFile(dest); err != nil || string(data) != "keep" {
				t.Fatalf("destination %q: %v", data, err)
			}
		})
	}
	content := store.Retrieval{Places: []store.Hit{{ID: 1}, {ID: 2}}}
	calls := 0
	_, err := copyCandidates(t.Context(), content, filepath.Join(t.TempDir(), "missing", "file"), content.Places, nil, func(store.Hit) (*os.File, error) { calls++; return nil, os.ErrNotExist })
	if err == nil || calls != 0 {
		t.Fatalf("invalid destination: calls=%d err=%v", calls, err)
	}
}

func TestCancellationRemovesOutput(t *testing.T) {
	root, destDir := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "source"), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	content := store.Retrieval{Digest: blake3.Sum256([]byte("original")), Size: 8, Places: []store.Hit{{ID: 1}}}
	_, err := copyCandidates(ctx, content, filepath.Join(destDir, "file"), content.Places, nil, func(store.Hit) (*os.File, error) {
		f, err := disk.OpenOrdinary(root, "source")
		cancel()
		return f, err
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
	if entries, err := os.ReadDir(destDir); err != nil || len(entries) != 0 {
		t.Fatalf("output remains: %v %v", entries, err)
	}
}

func TestOfflineAndMissingCopies(t *testing.T) {
	known := []store.Volume{{ID: "offline-id", Label: "Backup", FS: "TEST", Serial: "one", DeviceSerial: "device"}}
	content := store.Retrieval{Places: []store.Hit{{ID: 1, VolumeID: "offline-id", Volume: "Backup"}}}
	destDir := t.TempDir()
	for _, mounted := range [][]disk.Volume{nil, {{Fingerprint: disk.Fingerprint{FS: "TEST", Serial: "one"}}}} {
		_, err := Get(t.Context(), content, filepath.Join(destDir, "file"), known, mounted, config.Config{})
		if err == nil || !strings.Contains(err.Error(), "Backup") || !strings.Contains(err.Error(), "offline-id") {
			t.Fatalf("offline guidance: %v", err)
		}
	}
	content.Places[0].Missing = true
	_, err := Get(t.Context(), content, filepath.Join(destDir, "file"), known, []disk.Volume{{Fingerprint: disk.Fingerprint{FS: "TEST", Serial: "one", DeviceSerial: "device"}}}, config.Config{})
	if err == nil || !strings.Contains(err.Error(), "rescan") {
		t.Fatalf("missing: %v", err)
	}
	if entries, err := os.ReadDir(destDir); err != nil || len(entries) != 0 {
		t.Fatalf("output remains: %v %v", entries, err)
	}
}

func TestWindowsDestinationMustBeOffSourceVolume(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows volume validation")
	}
	dir := t.TempDir()
	mount, _, err := disk.Locate(dir)
	if err != nil {
		t.Fatal(err)
	}
	mount.DeviceSerial = "fixture"
	known := []store.Volume{{ID: "source", FS: mount.FS, Serial: mount.Serial, DeviceSerial: "fixture"}}
	content := store.Retrieval{Places: []store.Hit{{ID: 1, VolumeID: "source", Path: "/file"}}}
	_, err = Get(t.Context(), content, filepath.Join(dir, "file"), known, []disk.Volume{mount}, config.Config{})
	if err == nil || !strings.Contains(err.Error(), "off the source volume") {
		t.Fatalf("volume check: %v", err)
	}
	if entries, err := os.ReadDir(dir); err != nil || len(entries) != 0 {
		t.Fatalf("wrote to source volume: %v %v", entries, err)
	}
}

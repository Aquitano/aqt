package dedupe

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"lukechampine.com/blake3"

	"github.com/aquitano/aqt/apps/attic/internal/store"
)

type recorder struct {
	moves []store.DedupeMove
	fail  bool
}

func (r *recorder) RecordDedupeMove(_ context.Context, m store.DedupeMove) error {
	if r.fail {
		return errors.New("catalogue unavailable")
	}
	r.moves = append(r.moves, m)
	return nil
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
			write := func(root, rel string, data []byte) {
				t.Helper()
				path := filepath.Join(root, filepath.FromSlash(rel))
				if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, data, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			write(keptRoot, "Files/server.zip", tc.kept)
			write(extraRoot, "Backup/server.zip", tc.extra)
			group := store.DedupeGroup{
				ContentID: 7, Digest: blake3.Sum256(content), Ref: "0123456789abcdef", Size: int64(len(content)),
				Kept:  []store.Hit{{ID: 1, VolumeID: "kept", Path: "/Files/server.zip"}},
				Extra: []store.Hit{{ID: 2, VolumeID: "extra", Path: "/Backup/server.zip", Size: int64(len(content))}},
			}
			rec := &recorder{fail: tc.failRecording}
			res, err := Apply(t.Context(), rec, []store.DedupeGroup{group}, map[string]string{"kept": keptRoot, "extra": extraRoot}, "run")

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

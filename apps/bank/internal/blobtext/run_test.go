package blobtext

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/packages/go/extract"
)

// fakeArchive stands in for Postgres plus the blob store, so the pass itself
// can be tested without either.
type fakeArchive struct {
	blobs   map[content.Digest]string // file path
	names   map[content.Digest]string
	refs    []store.BlobRef
	stored  map[string]store.BlobText
	openErr error
}

func (f *fakeArchive) ListBlobs(_ context.Context, o store.ListBlobsOpts) ([]store.BlobRef, error) {
	var out []store.BlobRef
	for _, r := range f.refs {
		if len(o.Statuses) > 0 && !contains(o.Statuses, r.Status) {
			continue
		}
		out = append(out, r)
	}
	if o.Limit > 0 && len(out) > o.Limit {
		out = out[:o.Limit]
	}
	return out, nil
}

func contains(ss []string, s string) bool {
	for _, v := range ss {
		if v == s {
			return true
		}
	}
	return false
}

func (f *fakeArchive) PutBlobText(_ context.Context, bt store.BlobText) error {
	if f.stored == nil {
		f.stored = map[string]store.BlobText{}
	}
	f.stored[f.names[bt.BLAKE3]] = bt
	return nil
}

func (f *fakeArchive) OpenBlob(_ context.Context, d content.Digest) (string, func(), error) {
	if f.openErr != nil {
		return "", func() {}, f.openErr
	}
	return f.blobs[d], func() {}, nil
}

func archiveWith(t *testing.T, files map[string]string) *fakeArchive {
	t.Helper()
	dir := t.TempDir()
	a := &fakeArchive{blobs: map[content.Digest]string{}, names: map[content.Digest]string{}}
	for name, data := range files {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
		sum := content.Sum([]byte(data))
		a.blobs[sum], a.names[sum] = path, name
		a.refs = append(a.refs, store.BlobRef{
			BLAKE3: sum, Filename: name, SizeBytes: int64(len(data)), Status: store.StatusPending,
		})
	}
	return a
}

func TestRunExtractsAndRecordsEveryOutcome(t *testing.T) {
	a := archiveWith(t, map[string]string{
		"notes.txt": "the quarterly numbers",
		"clip.mkv":  "binary",
		"scan.png":  "pixels",
	})
	sum, err := Run(context.Background(), a, Selection{}, extract.Options{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if sum.Considered != 3 {
		t.Fatalf("considered %d, want 3", sum.Considered)
	}
	want := map[string]int{"ok": 1, "unsupported": 1, "needs_ocr": 1}
	for status, n := range want {
		if sum.ByStatus[status] != n {
			t.Errorf("%s = %d, want %d (all: %v)", status, sum.ByStatus[status], n, sum.ByStatus)
		}
	}
	if a.stored["notes.txt"].Text != "the quarterly numbers" {
		t.Errorf("text = %q", a.stored["notes.txt"].Text)
	}
	// Every blob gets a row, including the ones nothing could read: without
	// one they would be retried forever.
	if len(a.stored) != 3 {
		t.Errorf("stored %d rows, want one per blob", len(a.stored))
	}
}

// A blob that cannot be read is one bad row, not a failed run: an archive of
// decades of mail will always hold something unreadable.
func TestRunContinuesPastAnUnreadableBlob(t *testing.T) {
	a := archiveWith(t, map[string]string{"notes.txt": "fine"})
	a.openErr = errors.New("blob missing")
	sum, err := Run(context.Background(), a, Selection{}, extract.Options{}, nil)
	if err != nil {
		t.Fatalf("run aborted: %v", err)
	}
	if sum.ByStatus["failed"] != 1 {
		t.Fatalf("by status = %v, want one failure", sum.ByStatus)
	}
	if len(sum.Errors) != 1 {
		t.Fatalf("errors = %v, want the cause reported", sum.Errors)
	}
}

func TestRunRefusesOCRWithoutTheTools(t *testing.T) {
	a := archiveWith(t, map[string]string{"scan.png": "pixels"})
	_, err := Run(context.Background(), a, Selection{}, extract.Options{OCR: true, Tesseract: "not-installed-xyz"}, nil)
	if err == nil {
		t.Fatal("want an error up front rather than one failure per blob")
	}
	if len(a.stored) != 0 {
		t.Fatalf("stored %d rows before failing", len(a.stored))
	}
}

func TestRunSelectsByStatus(t *testing.T) {
	a := archiveWith(t, map[string]string{"notes.txt": "text", "scan.png": "pixels"})
	a.refs[0].Status = "needs_ocr"
	a.refs[1].Status = store.StatusPending

	sum, err := Run(context.Background(), a, Selection{Statuses: []string{"needs_ocr"}}, extract.Options{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if sum.Considered != 1 {
		t.Fatalf("considered %d, want only the requested status", sum.Considered)
	}
}

// The guarantee the archive makes about hand-made text: no automatic pass
// replaces it, however the selection was built.
func TestRunNeverTouchesManualText(t *testing.T) {
	a := archiveWith(t, map[string]string{"notes.txt": "the parsed text", "scan.png": "pixels"})
	for i := range a.refs {
		if a.refs[i].Filename == "notes.txt" {
			a.refs[i].Status = string(extract.StatusManual)
		}
	}

	sum, err := Run(context.Background(), a, Selection{Statuses: []string{string(extract.StatusManual), store.StatusPending}}, extract.Options{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if sum.Considered != 1 {
		t.Fatalf("considered %d, want only the blob that is not a transcription", sum.Considered)
	}
	if _, ok := a.stored["notes.txt"]; ok {
		t.Error("a manual transcription was overwritten by an automatic pass")
	}
}

// Asking for OCR has to imply the files that need it. Anything else means the
// obvious command does nothing, and the useful one is an incantation.
func TestOCRImpliesTheNeedsOCRQueue(t *testing.T) {
	cases := []struct {
		named []string
		ocr   bool
		want  []string
	}{
		{nil, false, []string{store.StatusPending}},
		{nil, true, []string{store.StatusPending, "needs_ocr"}},
		// An explicit selection is never widened: --status failed with --ocr
		// retries failures, it does not also sweep the whole queue.
		{[]string{"failed"}, true, []string{"failed"}},
	}
	for _, c := range cases {
		got := defaultStatuses(c.named, c.ocr)
		if strings.Join(got, ",") != strings.Join(c.want, ",") {
			t.Errorf("defaultStatuses(%v, %v) = %v, want %v", c.named, c.ocr, got, c.want)
		}
	}
}

func TestRunWithOCRPicksUpNeedsOCR(t *testing.T) {
	a := archiveWith(t, map[string]string{"scan.png": "pixels"})
	a.refs[0].Status = "needs_ocr"
	tess := fakeBin(t, "tesseract", `echo "read from the scan"`)

	sum, err := Run(context.Background(), a, Selection{}, extract.Options{OCR: true, Tesseract: tess, PDFToPPM: "echo"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if sum.ByStatus["ok"] != 1 {
		t.Fatalf("by status = %v, want the queued scan read", sum.ByStatus)
	}
}

// fakeBin writes a script standing in for tesseract, so the OCR queue is
// tested without it.
func fakeBin(t *testing.T, name, body string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell script stand-ins are POSIX only")
	}
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

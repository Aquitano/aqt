package verify

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestRunFindsMissingAndCorruptBlobs(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	blobs, err := blob.New(filepath.Join(t.TempDir(), "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	put := func(data string) store.Attachment {
		sum, size, err := blobs.Put(ctx, bytes.NewReader([]byte(data)))
		if err != nil {
			t.Fatal(err)
		}
		return store.Attachment{BLAKE3: sum, SizeBytes: size}
	}
	intact, missing, corrupt := put("intact"), put("missing"), put("corrupt")
	if _, err := st.AddRawInput(ctx, "json", "input.json", intact.BLAKE3, intact.SizeBytes, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	id, err := st.InsertMessage(ctx, store.Message{Source: "notes", ExternalID: "one", Body: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	for i, a := range []store.Attachment{intact, missing, corrupt} {
		a.MessageID, a.Position, a.Filename = id, i, "file"
		if err := st.InsertAttachment(ctx, a); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Remove(blobs.Path(missing.BLAKE3)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(blobs.Path(corrupt.BLAKE3), []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	rep, err := Run(ctx, st, blobs)
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]bool{}
	for _, f := range rep.Findings {
		kinds[f.Kind] = true
	}
	if rep.ContentsChecked != 3 || rep.Damaged != 2 || !kinds[MissingBlob] || !kinds[CorruptBlob] {
		t.Fatalf("report: %+v", rep)
	}
}

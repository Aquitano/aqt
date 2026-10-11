package scan

import (
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/config"
	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/apps/attic/internal/storetest"
)

func pngFile(t *testing.T, root, name string) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 23, 17))
	img.Set(0, 0, color.RGBA{R: 123, A: 255})
	f, err := os.Create(filepath.Join(root, name))
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func requireExifTool(t *testing.T) string {
	t.Helper()
	p, err := exec.LookPath("exiftool")
	if err != nil {
		if os.Getenv("CI") != "" {
			t.Fatal(err)
		}
		t.Skip("ExifTool not installed")
	}
	return p
}

func TestMetadataScanDeduplicatesAndSearches(t *testing.T) {
	binary := requireExifTool(t)
	st, dsn := storetest.New(t)
	root := t.TempDir()
	pngFile(t, root, "one.png")
	data, err := os.ReadFile(filepath.Join(root, "one.png"))
	if err != nil {
		t.Fatal(err)
	}
	write(t, root, "two.png", string(data))
	write(t, root, "private.png", string(data))
	cfg := config.Config{Metadata: config.Metadata{Enabled: true, ExifTool: binary, Temp: t.TempDir(), MaxBytes: 1 << 20}, NameOnly: []string{"private.png"}}
	first := scanAt(t, st, root, testVolume, func(o *Options) { o.Config = cfg })
	if first.Counts.Metadata != 1 || first.Phases.Metadata == 0 {
		t.Fatalf("first metadata scan: %+v", first)
	}
	second := scanAt(t, st, root, testVolume, func(o *Options) { o.Config = cfg })
	if second.Counts.Metadata != 0 {
		t.Fatalf("unchanged content reread: %+v", second.Counts)
	}
	hit := find(t, st, "one.png")
	d, err := st.Metadata(context.Background(), hit.ID, "")
	if err != nil || d.Status != "ok" || d.Tags["PNG:ImageWidth"] != float64(23) {
		t.Fatalf("metadata: %+v, %v", d, err)
	}
	if _, err := st.Metadata(context.Background(), 0, hit.Ref); err != nil {
		t.Fatal(err)
	}
	detail, err := st.Entry(context.Background(), hit.ID)
	if err != nil || detail.Metadata == nil {
		t.Fatalf("entry: %+v %v", detail, err)
	}
	hits, err := st.SearchMetadata(context.Background(), store.SearchOptions{Query: "PNG", Ext: "png", Limit: 10})
	if err != nil || len(hits) != 1 || len(hits[0].Places) != 2 {
		t.Fatalf("search: %+v %v", hits, err)
	}
	if hits, err := st.SearchMetadata(context.Background(), store.SearchOptions{Query: "PNG", Ext: "jpg"}); err != nil || len(hits) != 0 {
		t.Fatalf("extension filter: %+v %v", hits, err)
	}
	if got := storetest.QueryInt(t, dsn, "select metadata from scans where id=$1", first.ScanID); got != 1 {
		t.Fatalf("scan metadata count %d", got)
	}
	stats, err := st.Totals(context.Background())
	if err != nil || stats.Metadata != 1 {
		t.Fatalf("totals: %+v %v", stats, err)
	}
	scans, err := st.Scans(context.Background(), "", 5)
	if err != nil || len(scans) != 2 || scans[1].Metadata != 1 || scans[1].Phases.Metadata <= 0 {
		t.Fatalf("scans: %+v %v", scans, err)
	}
}

func TestMetadataSizeCapRetriesAndMissingToolKeepsQueue(t *testing.T) {
	binary := requireExifTool(t)
	st, _ := storetest.New(t)
	root := t.TempDir()
	pngFile(t, root, "image.png")
	cfg := config.Config{Metadata: config.Metadata{Enabled: true, ExifTool: "nonexistent-attic-exiftool", Temp: t.TempDir(), MaxBytes: 1}}
	missing := scanAt(t, st, root, testVolume, func(o *Options) { o.Config = cfg })
	if missing.Counts.Metadata != 0 || missing.Counts.Skipped != 1 {
		t.Fatalf("missing tool: %+v", missing.Counts)
	}
	cfg.Metadata.ExifTool = binary
	capped := scanAt(t, st, root, testVolume, func(o *Options) { o.Config = cfg })
	if capped.Counts.Metadata != 0 || capped.Counts.Skipped != 1 {
		t.Fatalf("size cap: %+v", capped.Counts)
	}
	cfg.Metadata.MaxBytes = 1 << 20
	retried := scanAt(t, st, root, testVolume, func(o *Options) { o.Config = cfg })
	if retried.Counts.Metadata != 1 {
		t.Fatalf("raised cap: %+v", retried.Counts)
	}
}

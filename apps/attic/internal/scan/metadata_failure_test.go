package scan

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/config"
	"github.com/aquitano/aqt/apps/attic/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

func TestMain(m *testing.M) {
	if os.Getenv("ATTIC_SCAN_METADATA_HELPER") == "1" {
		paths := os.Args[slices.Index(os.Args, "--")+1:]
		rows := make([]map[string]any, 0, len(paths))
		for _, path := range paths {
			data, err := os.ReadFile(path)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(2)
			}
			if strings.Contains(string(data), "poison") {
				fmt.Print("broken JSON")
				os.Exit(0)
			}
			rows = append(rows, map[string]any{"SourceFile": path, "PNG:ImageWidth": 23})
		}
		_ = json.NewEncoder(os.Stdout).Encode(rows)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestMetadataBadBatchDoesNotStarveLaterFiles(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ATTIC_SCAN_METADATA_HELPER", "1")
	st, dsn := storetest.New(t)
	root := t.TempDir()
	write(t, root, "a-poison.png", "poison")
	write(t, root, "b-good.png", "good")
	for i := range 64 {
		write(t, root, fmt.Sprintf("b-good-%02d.png", i), fmt.Sprintf("good %d", i))
	}
	cfg := config.Config{Metadata: config.Metadata{Enabled: true, ExifTool: binary, Temp: t.TempDir(), MaxBytes: 1 << 20}}
	first := scanAt(t, st, root, testVolume, func(o *Options) { o.Config = cfg })
	if first.Counts.Metadata != 65 || first.Counts.Skipped != 1 {
		t.Fatalf("first: %+v", first)
	}
	if n := pgschematest.QueryInt(t, dsn, "select count(*) from metadata"); n != 65 {
		t.Fatalf("stored %d, want all good files", n)
	}
	second := scanAt(t, st, root, testVolume, func(o *Options) { o.Config = cfg })
	if second.Counts.Metadata != 0 || second.Counts.Skipped != 1 {
		t.Fatalf("retry: %+v", second)
	}
	if err := os.WriteFile(filepath.Join(root, "c-later.png"), []byte("later"), 0600); err != nil {
		t.Fatal(err)
	}
	third := scanAt(t, st, root, testVolume, func(o *Options) { o.Config = cfg })
	if third.Counts.Metadata != 1 || third.Counts.Skipped != 1 {
		t.Fatalf("later: %+v", third)
	}
	groups, err := st.SkipGroups(context.Background(), third.ScanID)
	if err != nil || len(groups) != 1 || groups[0].Reason != "metadata_failed" {
		t.Fatalf("skips %+v %v", groups, err)
	}
}

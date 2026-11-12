package scan

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/attic/config"
	"github.com/aquitano/aqt/apps/bank/internal/attic/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

// TestMain also runs the ExifTool and pdftotext stand-ins.
func TestMain(m *testing.M) {
	if os.Getenv("ATTIC_SCAN_PDF_HELPER") != "" {
		if err := replaceHelperSource(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		data, err := os.ReadFile(os.Args[1])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		fmt.Print(string(data))
		os.Exit(0)
	}
	if os.Getenv("ATTIC_SCAN_METADATA_HELPER") == "" {
		os.Exit(m.Run())
	}
	in := bufio.NewScanner(os.Stdin)
	var path string
	for in.Scan() {
		n, ok := strings.CutPrefix(in.Text(), "-execute")
		if !ok {
			path = in.Text()
			continue
		}
		if err := replaceHelperSource(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		data, err := os.ReadFile(path)
		switch {
		case err != nil:
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		case strings.Contains(string(data), "poison"):
			fmt.Println("broken JSON")
		default:
			_ = json.NewEncoder(os.Stdout).Encode([]map[string]any{{"SourceFile": path, "PNG:ImageWidth": 23, "Test:Bytes": string(data)}})
		}
		fmt.Printf("{ready%s}\n", n)
	}
	if in.Err() != nil {
		os.Exit(3)
	}
	os.Exit(0)
}

func replaceHelperSource() error {
	source := os.Getenv("ATTIC_SCAN_METADATA_REPLACE")
	if source == "" {
		return nil
	}
	if err := os.Rename(source, source+".old"); err != nil {
		return err
	}
	return os.WriteFile(source, []byte("replacement"), 0o600)
}

func TestMetadataToolFailureDoesNotStarveLaterFiles(t *testing.T) {
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

func TestMetadataToolReadsVerifiedCopyAfterSourceReplacement(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	st, _ := storetest.New(t)
	root, temp := t.TempDir(), t.TempDir()
	write(t, root, "image.png", "original")
	source := filepath.Join(root, "image.png")
	t.Setenv("ATTIC_SCAN_METADATA_HELPER", "1")
	t.Setenv("ATTIC_SCAN_METADATA_REPLACE", source)
	res := scanAt(t, st, root, testVolume, func(o *Options) {
		o.Config = config.Config{Temp: temp, Metadata: config.Metadata{Enabled: true, ExifTool: binary}}
	})
	if res.Counts.Metadata != 1 {
		t.Fatalf("metadata: %+v", res.Counts)
	}
	result, err := st.Metadata(t.Context(), find(t, st, "image.png").ID, "")
	if err != nil || result.Tags["Test:Bytes"] != "original" {
		t.Fatalf("tool read a replacement object: %+v, %v", result, err)
	}
	if data, err := os.ReadFile(source); err != nil || string(data) != "replacement" {
		t.Fatalf("source was not replaced during the tool read: %q, %v", data, err)
	}
	if left, err := filepath.Glob(filepath.Join(temp, "aqt-attic", "scan-*")); err != nil || len(left) != 0 {
		t.Fatalf("scratch remains: %v, %v", left, err)
	}
}

func TestPDFFallbackReadsVerifiedCopyAfterSourceReplacement(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	st, _ := storetest.New(t)
	root, temp := t.TempDir(), t.TempDir()
	write(t, root, "document.pdf", "original")
	source := filepath.Join(root, "document.pdf")
	t.Setenv("ATTIC_SCAN_PDF_HELPER", "1")
	t.Setenv("ATTIC_SCAN_METADATA_REPLACE", source)
	res := scanAt(t, st, root, testVolume, func(o *Options) {
		o.Config = config.Config{Temp: temp, Text: config.Text{PDFToText: binary}}
	})
	if res.Counts.Texts != 1 {
		t.Fatalf("texts: %+v", res.Counts)
	}
	result, err := st.Text(t.Context(), find(t, st, "document.pdf").ID, "")
	if err != nil || result.Text != "original" {
		t.Fatalf("PDF tool read a replacement object: %+v, %v", result, err)
	}
	if data, err := os.ReadFile(source); err != nil || string(data) != "replacement" {
		t.Fatalf("source was not replaced during the tool read: %q, %v", data, err)
	}
	if left, err := filepath.Glob(filepath.Join(temp, "aqt-attic", "scan-*")); err != nil || len(left) != 0 {
		t.Fatalf("scratch remains: %v, %v", left, err)
	}
}

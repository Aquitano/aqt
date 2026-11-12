package metadata

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestMain doubles as a fake ExifTool in -stay_open mode. What it answers
// depends on the requested file's name.
func TestMain(m *testing.M) {
	if os.Getenv("ATTIC_METADATA_HELPER") == "" {
		os.Exit(m.Run())
	}
	in := bufio.NewScanner(os.Stdin)
	var name string
	for in.Scan() {
		line := in.Text()
		n, ok := strings.CutPrefix(line, "-execute")
		if !ok {
			name = line
			continue
		}
		switch {
		case strings.Contains(name, "hang"):
			time.Sleep(time.Hour)
		case strings.Contains(name, "invalid"):
			fmt.Print("not JSON\n")
		case strings.Contains(name, "damaged"):
			_ = json.NewEncoder(os.Stdout).Encode([]map[string]any{{"SourceFile": name, "ExifTool:Error": "damaged"}})
		default:
			_ = json.NewEncoder(os.Stdout).Encode([]map[string]any{{"SourceFile": name, "EXIF:Model": "camera", "pid": os.Getpid()}})
		}
		fmt.Printf("{ready%s}\n", n)
	}
	if in.Err() != nil {
		os.Exit(3)
	}
	os.Exit(0)
}

func fakeExifTool(t *testing.T) *Reader {
	t.Helper()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ATTIC_METADATA_HELPER", "1")
	r := NewReader(binary)
	t.Cleanup(r.Close)
	return r
}

func TestReaderKeepsOneProcessAndReportsFileFailures(t *testing.T) {
	r := fakeExifTool(t)
	dir := t.TempDir()
	first, err := r.Read(t.Context(), filepath.Join(dir, "one.jpg"))
	if err != nil || first.Status != "ok" || first.Tags["EXIF:Model"] != "camera" {
		t.Fatalf("first: %+v %v", first, err)
	}
	second, err := r.Read(t.Context(), filepath.Join(dir, "two.jpg"))
	if err != nil || second.Tags["pid"] != first.Tags["pid"] {
		t.Fatalf("second file did not reuse the running ExifTool: %+v %v", second, err)
	}
	damaged, err := r.Read(t.Context(), filepath.Join(dir, "damaged.jpg"))
	if err != nil || damaged.Status != "failed" || damaged.Detail != "damaged" {
		t.Fatalf("file failure: %+v %v", damaged, err)
	}
	if _, err := r.Read(t.Context(), "relative.jpg"); err == nil {
		t.Fatal("relative path accepted")
	}
}

func TestReaderRestartsAfterBadAnswerOrTimeout(t *testing.T) {
	r := fakeExifTool(t)
	dir := t.TempDir()
	before, err := r.Read(t.Context(), filepath.Join(dir, "one.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	if res, err := r.Read(t.Context(), filepath.Join(dir, "invalid.jpg")); err == nil {
		t.Fatalf("bad answer accepted: %+v", res)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := r.Read(ctx, filepath.Join(dir, "hang.jpg")); err == nil || time.Since(start) > 5*time.Second {
		t.Fatalf("hung ExifTool: %v after %s", err, time.Since(start))
	}
	after, err := r.Read(t.Context(), filepath.Join(dir, "two.jpg"))
	if err != nil || after.Tags["pid"] == before.Tags["pid"] {
		t.Fatalf("no fresh ExifTool after failures: %+v %v", after, err)
	}
}

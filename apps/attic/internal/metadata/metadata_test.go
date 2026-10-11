package metadata

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"testing"
)

func TestMain(m *testing.M) {
	if mode := os.Getenv("ATTIC_METADATA_HELPER"); mode != "" {
		paths := os.Args[slices.Index(os.Args, "--")+1:]
		switch mode {
		case "invalid":
			fmt.Print("not JSON")
		case "partial":
			fmt.Print("[]")
		case "failure":
			_ = json.NewEncoder(os.Stdout).Encode([]map[string]any{{"SourceFile": paths[0], "ExifTool:Error": "damaged"}})
			os.Exit(1)
		case "reversed":
			_ = json.NewEncoder(os.Stdout).Encode([]map[string]any{{"SourceFile": paths[1], "EXIF:Model": "second"}, {"SourceFile": paths[0], "EXIF:Model": "first"}})
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestBatchMatchesPathsAndKeepsPerFileFailures(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ATTIC_METADATA_HELPER", "reversed")
	got, err := Read(context.Background(), binary, []string{"one.jpg", "two.jpg"})
	if err != nil || len(got) != 2 || got[0].Tags["EXIF:Model"] != "first" || got[1].Tags["EXIF:Model"] != "second" {
		t.Fatalf("reordered batch: %+v %v", got, err)
	}
	t.Setenv("ATTIC_METADATA_HELPER", "failure")
	got, err = Read(context.Background(), binary, []string{"bad.jpg"})
	if err != nil || len(got) != 1 || got[0].Status != "failed" || got[0].Detail != "damaged" {
		t.Fatalf("file failure: %+v %v", got, err)
	}
}

func TestBrokenBatchDoesNotReturnCacheableResults(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"invalid", "partial"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("ATTIC_METADATA_HELPER", mode)
			got, err := Read(context.Background(), binary, []string{"one.jpg"})
			if err == nil || got != nil {
				t.Fatalf("bad batch accepted: %+v %v", got, err)
			}
		})
	}
}

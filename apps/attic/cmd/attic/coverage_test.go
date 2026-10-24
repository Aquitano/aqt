package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/store"
)

func TestCoverageCLI(t *testing.T) {
	var root cli
	_, err := parseCLI(&root, []string{"coverage", "--volume", "Data", "--under", "/Files", "--limit", "5", "--offset", "10", "--json"})
	if err != nil || root.Coverage.Volume != "Data" || root.Coverage.Under != "/Files" || root.Coverage.Limit != 5 || root.Coverage.Offset != 10 || !root.Coverage.JSON {
		t.Fatalf("parse: %+v, %v", root.Coverage, err)
	}
	for _, cmd := range []coverageCmd{{Limit: 0}, {Limit: 1001}, {Limit: 20, Offset: -1}} {
		if err := cmd.Run(t.Context()); err == nil {
			t.Fatal("invalid page accepted")
		}
	}
}

func TestCoverageOutput(t *testing.T) {
	r := store.CoverageReport{Contents: 3, Bytes: 30, Undercovered: 1, UndercoveredBytes: 10, UnknownFiles: 1, UnknownBytes: 7,
		Limit: 20, LocationLimit: 100, Content: []store.CoverageContent{{ID: 1, BLAKE3: strings.Repeat("11", 32), Size: 10, Volumes: 1, Copies: 2}},
		Unknown: []store.CoverageLocation{{Hit: store.Hit{ID: 8, Volume: "Data", Path: "/unknown"}}}}
	var out bytes.Buffer
	if err := printCoverage(&out, r, true); err != nil {
		t.Fatal(err)
	}
	var decoded store.CoverageReport
	if err := json.Unmarshal(out.Bytes(), &decoded); err != nil || decoded.UndercoveredBytes != 10 || decoded.Unknown[0].ID != 8 {
		t.Fatalf("JSON: %s, %v", out.String(), err)
	}
	out.Reset()
	if err := printCoverage(&out, r, false); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(out.String(), "\n")
	for _, want := range []string{
		"3 unique contents, 30 B; 1 on fewer than two recorded volumes, 10 B",
		"1 unknown files, 7 B of path sizes (not deduplicated)",
		"10 B, 1 recorded volumes, 2 paths, BLAKE3 " + strings.Repeat("11", 32),
	} {
		if !slices.Contains(lines, want) {
			t.Errorf("missing line %q in %s", want, out.String())
		}
	}
	for _, want := range []string{"physical disk independence", "Unknown content hashes:", "/unknown", "scan 0 at"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("missing %q in %s", want, out.String())
		}
	}
}

func TestCoverageOutputWriteFailure(t *testing.T) {
	reader, writer := io.Pipe()
	reader.Close()
	defer writer.Close()
	for _, asJSON := range []bool{false, true} {
		if err := printCoverage(writer, store.CoverageReport{}, asJSON); !errors.Is(err, io.ErrClosedPipe) {
			t.Errorf("JSON=%t: got %v, want closed-pipe error", asJSON, err)
		}
	}
}

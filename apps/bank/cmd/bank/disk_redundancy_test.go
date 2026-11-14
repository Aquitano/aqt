package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

func TestRedundancyRefusesABadPageBeforeConnecting(t *testing.T) {
	connect := func(context.Context) (*client.Client, func(), error) {
		t.Fatal("connected for a page the server would refuse")
		return nil, nil, nil
	}
	for _, cmd := range []redundancyCmd{{Limit: 0}, {Limit: 1001}, {Limit: 20, Offset: -1}} {
		if err := cmd.Run(t.Context(), connect); err == nil {
			t.Fatal("invalid page accepted")
		}
	}
}

func TestRedundancyOutput(t *testing.T) {
	r := store.RedundancyReport{Contents: 3, Bytes: 30, SingleVolume: 1, SingleVolumeBytes: 10, UnknownFiles: 1, UnknownBytes: 7,
		Limit: 20, LocationLimit: 100, Content: []store.RedundancyContent{{ID: 1, BLAKE3: strings.Repeat("11", 32), Size: 10, Volumes: 1, Copies: 2}},
		Unknown: []store.RedundancyLocation{{Hit: store.Hit{ID: 8, Volume: "Data", Path: "/unknown"}}}}
	var out bytes.Buffer
	if err := printRedundancy(&out, r, true); err != nil {
		t.Fatal(err)
	}
	var decoded store.RedundancyReport
	if err := json.Unmarshal(out.Bytes(), &decoded); err != nil || decoded.SingleVolumeBytes != 10 || decoded.Unknown[0].ID != 8 {
		t.Fatalf("JSON: %s, %v", out.String(), err)
	}
	out.Reset()
	if err := printRedundancy(&out, r, false); err != nil {
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

func TestRedundancyOutputWriteFailure(t *testing.T) {
	reader, writer := io.Pipe()
	reader.Close()
	defer writer.Close()
	for _, asJSON := range []bool{false, true} {
		if err := printRedundancy(writer, store.RedundancyReport{}, asJSON); !errors.Is(err, io.ErrClosedPipe) {
			t.Errorf("JSON=%t: got %v, want closed-pipe error", asJSON, err)
		}
	}
}

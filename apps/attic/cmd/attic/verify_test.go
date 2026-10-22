package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/storetest"
	"github.com/aquitano/aqt/apps/attic/internal/verify"
)

func TestVerifyRequiresExplicitScope(t *testing.T) {
	for _, args := range [][]string{{"verify"}, {"verify", "--volume", "Data"}} {
		if err := execute(t.Context(), args); err == nil || !strings.Contains(err.Error(), "requires --under") {
			t.Fatalf("%v: %v", args, err)
		}
	}
	var root cli
	if _, err := parseCLI(&root, []string{"verify", "--under", `E:\Files`, "--volume", "Data", "--json"}); err != nil {
		t.Fatal(err)
	}
	if root.Verify.Under != `E:\Files` || root.Verify.Volume != "Data" || !root.Verify.JSON {
		t.Fatalf("%+v", root.Verify)
	}
	for _, under := range []string{"/files/../other", "/files//other", `/files\child`} {
		if _, _, _, err := verificationScope(under, "id", nil); err == nil {
			t.Fatalf("accepted %s", under)
		}
	}
	if _, _, _, err := verificationScope("/files", "", nil); err == nil {
		t.Fatal("accepted unscoped relative path")
	}
}

func TestVerifyJSONReportsUnknownAndIncompleteSelections(t *testing.T) {
	st, _ := storetest.New(t)
	const volume = "00000000-0000-0000-0000-000000000001"
	var out bytes.Buffer
	if err := writeVerification(t.Context(), st, volume, "/unknown", disk.Volume{}, true, &out); err == nil {
		t.Fatal("unknown scope succeeded")
	}
	dec := json.NewDecoder(&out)
	var entry verify.Result
	var summary verify.Summary
	if err := dec.Decode(&entry); err != nil {
		t.Fatal(err)
	}
	if err := dec.Decode(&summary); err != nil {
		t.Fatal(err)
	}
	if entry.Status != "unknown" || summary.Type != "summary" || !summary.Complete || summary.Unknown != 1 {
		t.Fatalf("%+v, %+v", entry, summary)
	}
	out.Reset()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := writeVerification(ctx, st, volume, "/unknown", disk.Volume{}, true, &out); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
	if err := json.Unmarshal(out.Bytes(), &summary); err != nil {
		t.Fatal(err)
	}
	if summary.Type != "summary" || summary.Complete {
		t.Fatalf("%+v", summary)
	}
}

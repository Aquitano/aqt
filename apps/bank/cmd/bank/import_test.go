package main

import (
	"context"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/mediaimport"
)

func TestMediaImportOutcomeKeepsKnownRecordsWithSkippedRows(t *testing.T) {
	result := mediaimport.Result{ImportResult: library.ImportResult{Duplicates: 2}, Skipped: 1}
	outcome := importOutcome(result)
	if outcome.Inserted != 0 || outcome.Duplicates != 2 || outcome.Rejected != 1 {
		t.Fatalf("lost known records on partial replay: %+v", outcome)
	}
}

func TestMediaImportRejectsInvalidDateOrderBeforeOpeningStore(t *testing.T) {
	for _, args := range []struct{ kind, order string }{{"netflix", "auto"}, {"youtube-media", "dmy"}} {
		err := execute(context.Background(), []string{"import", args.kind, "input.csv", "--date-order", args.order})
		if err == nil || !strings.Contains(err.Error(), "--date-order") {
			t.Fatalf("invalid date order reached the importer: %v", err)
		}
	}
}

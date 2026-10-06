package blobtext

import (
	"strings"
	"testing"
)

func TestValidStatus(t *testing.T) {
	// "pending" is not one of the stored statuses but is a valid thing to ask
	// for, and the message has to say so or a correct choice looks wrong.
	for _, ok := range []string{"needs_ocr", "pending", "manual"} {
		if err := ValidStatus(ok); err != nil {
			t.Errorf("ValidStatus(%q) = %v", ok, err)
		}
	}
	err := ValidStatus("needsocr")
	if err == nil {
		t.Fatal("a typo should not silently select nothing")
	}
	if !strings.Contains(err.Error(), "pending") {
		t.Errorf("error should list every accepted status: %v", err)
	}
}

// A status is checked twice over, for two different questions: which content
// to select, and what may be written to a row.
func TestValidStoredStatusRejectsPending(t *testing.T) {
	for _, ok := range []string{"ok", "needs_ocr", "manual", "failed"} {
		if err := ValidStoredStatus(ok); err != nil {
			t.Errorf("ValidStoredStatus(%q) = %v", ok, err)
		}
	}
	// Pending is the absence of a row. Stored, it would strand the content
	// where no default pass ever selects it again.
	for _, bad := range []string{"pending", "", "OK", "done"} {
		if err := ValidStoredStatus(bad); err == nil {
			t.Errorf("ValidStoredStatus(%q) accepted", bad)
		}
	}
}

// Manual text is someone's own transcription: an automatic pass over it would
// replace work nothing can rebuild.
func TestValidRunStatusRejectsManual(t *testing.T) {
	err := ValidRunStatus("manual")
	if err == nil {
		t.Fatal("a run over manual text would overwrite it")
	}
	if !strings.Contains(err.Error(), "--set") {
		t.Errorf("error should say how to replace a transcription: %v", err)
	}
	for _, ok := range []string{"pending", "failed", "needs_ocr"} {
		if err := ValidRunStatus(ok); err != nil {
			t.Errorf("ValidRunStatus(%q) = %v", ok, err)
		}
	}
}

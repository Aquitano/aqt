package library

import "testing"

func TestProvenanceRejectsNegativeRawInputs(t *testing.T) {
	if err := (Provenance{RawInput: -1}).Validate(); err == nil {
		t.Error("negative raw input accepted")
	}
	if err := (Provenance{RawInput: 3, Locator: "watch-history.json: record 1"}).Validate(); err != nil {
		t.Error(err)
	}
}

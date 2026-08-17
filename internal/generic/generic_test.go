package generic

import (
	"testing"
	"time"
)

func TestParseEntriesArrayAndNDJSON(t *testing.T) {
	array := `[{"source":"notes","body":"one"},{"source":"notes","body":"two"}]`
	ndjson := "{\"source\":\"notes\",\"body\":\"one\"}\n{\"source\":\"notes\",\"body\":\"two\"}\n"
	for _, input := range []string{array, ndjson} {
		entries, err := parseEntries([]byte(input))
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 2 || entries[0].Body != "one" || entries[1].Body != "two" {
			t.Fatalf("entries = %+v", entries)
		}
	}
}

func TestDerivedIDStableWithoutSentAt(t *testing.T) {
	e := entry{Source: "notes", Body: "buy milk"}
	first := derivedID(e, time.Time{}, map[string]int{})
	second := derivedID(e, time.Time{}, map[string]int{})
	if first != second {
		t.Error("id without sent_at must not depend on import time")
	}
	// Same entry twice in ONE batch keeps both, reproducibly.
	seen := map[string]int{}
	a, b := derivedID(e, time.Time{}, seen), derivedID(e, time.Time{}, seen)
	if a == b {
		t.Error("duplicate entries in one batch collided")
	}
	seen2 := map[string]int{}
	if derivedID(e, time.Time{}, seen2) != a || derivedID(e, time.Time{}, seen2) != b {
		t.Error("batch counter not reproducible across re-imports")
	}
}

func TestParseSentAt(t *testing.T) {
	for raw, want := range map[string]time.Time{
		`"2024-05-13T21:08:00Z"`: time.Date(2024, 5, 13, 21, 8, 0, 0, time.UTC),
		`"2024-05-13 21:08:00"`:  time.Date(2024, 5, 13, 21, 8, 0, 0, time.Local),
		`"2024-05-13"`:           time.Date(2024, 5, 13, 0, 0, 0, 0, time.Local),
		`1715629680`:             time.Unix(1715629680, 0),
	} {
		got, err := parseSentAt([]byte(raw))
		if err != nil {
			t.Errorf("%s: %v", raw, err)
			continue
		}
		if !got.Equal(want) {
			t.Errorf("%s = %v, want %v", raw, got, want)
		}
	}
	if got, err := parseSentAt(nil); err != nil || !got.IsZero() {
		t.Errorf("missing sent_at: got %v, %v", got, err)
	}
	if _, err := parseSentAt([]byte(`"yesterday-ish"`)); err == nil {
		t.Error("garbage sent_at should error")
	}
}

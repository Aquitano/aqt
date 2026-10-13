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

func TestParseEntriesRejectsTrailingData(t *testing.T) {
	bad := map[string]string{
		"second value":  `[{"body":"one"}] {"body":"two"}`,
		"garbage":       `[{"body":"one"}] nonsense`,
		"second array":  `[{"body":"one"}][{"body":"two"}]`,
		"stray bracket": `[{"body":"one"}]]`,
	}
	for name, input := range bad {
		t.Run(name, func(t *testing.T) {
			if entries, err := parseEntries([]byte(input)); err == nil {
				t.Fatalf("accepted %q as %d entries", input, len(entries))
			}
		})
	}

	good := map[string]int{
		`[{"body":"one"}]`:                       1,
		"[{\"body\":\"one\"}]\n\n  \t\n":         1,
		`{"body":"one"}`:                         1,
		"{\"body\":\"one\"}\n{\"body\":\"two\"}": 2,
		`[]`:                                     0,
	}
	for input, want := range good {
		entries, err := parseEntries([]byte(input))
		if err != nil {
			t.Errorf("%q: %v", input, err)
			continue
		}
		if len(entries) != want {
			t.Errorf("%q: got %d entries, want %d", input, len(entries), want)
		}
	}
}

func TestValidateRejectsUnsafeSource(t *testing.T) {
	if err := validate(entry{Source: "../escape", Body: "x"}); err == nil {
		t.Error("a traversal source was accepted")
	}
	if err := validate(entry{Source: "agent-notes", Body: "x"}); err != nil {
		t.Errorf("ordinary source rejected: %v", err)
	}
}

func TestRemoteEntryLimitBoundsSmallObjects(t *testing.T) {
	for _, input := range []string{"[{},{},{}]", "{}\n{}\n{}"} {
		if _, err := parseEntriesBounded([]byte(input), 2); err == nil {
			t.Fatalf("accepted too many entries: %s", input)
		}
		entries, err := parseEntriesBounded([]byte(input), 3)
		if err != nil || len(entries) != 3 {
			t.Fatalf("at limit: %d entries, %v", len(entries), err)
		}
	}
}

package store

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// The cap that keeps a row bounded must not be what makes the insert fail:
// Postgres rejects invalid UTF-8, and a byte cut through a multi-byte
// character is exactly that. Reachable from a transcription posted over HTTP
// or read from a file, neither of which is capped by the extractors.
func TestTruncateRunesKeepsValidUTF8(t *testing.T) {
	multi := strings.Repeat("é", 10) // two bytes per rune
	for max := 0; max <= len(multi); max++ {
		got := truncateRunes(multi, max)
		if len(got) > max {
			t.Fatalf("truncateRunes(%d) = %d bytes", max, len(got))
		}
		if !utf8.ValidString(got) {
			t.Fatalf("truncateRunes(%d) split a rune: %q", max, got)
		}
	}
	if got := truncateRunes("short", 64); got != "short" {
		t.Errorf("text under the cap was changed: %q", got)
	}
}

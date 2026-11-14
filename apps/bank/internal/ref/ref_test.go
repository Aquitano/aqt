package ref_test

import (
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/ref"
)

func TestParse(t *testing.T) {
	hex := func(n int) string { return strings.Repeat("0123456789abcdef", 4)[:n] }
	for _, tc := range []struct {
		in   string
		kind ref.Kind
	}{
		{"msg:" + hex(16), ref.KindMessage},
		{"content:" + hex(16), ref.KindContent},
		{"content:" + hex(40), ref.KindContent},
		{"content:" + hex(64), ref.KindContent},
		{"item:" + hex(32), ref.KindItem},
		{"activity:" + hex(32), ref.KindActivity},
		{"collection:" + hex(32), ref.KindCollection},
		{"file:" + hex(32), ref.KindFile},
		{"page:" + hex(32), ref.KindPage},
		{"", ""},
		{hex(16), ""},
		{hex(64), ""},
		{"bank:" + hex(12), ""},
		{"attic:" + hex(16), ""},
		{"item_" + hex(32), ""},
		{"msg:" + hex(15), ""},
		{"msg:" + hex(16) + "0", ""},
		{"msg:" + strings.ToUpper(hex(16)), ""},
		{"MSG:" + hex(16), ""},
		{" msg:" + hex(16), ""},
		{"msg:" + hex(15) + "g", ""},
		{"content:" + hex(15), ""},
		{"content:" + hex(64) + "0", ""},
		{"item:" + hex(31), ""},
		{"page:" + hex(16), ""},
	} {
		got, err := ref.Parse(tc.in)
		if tc.kind == "" {
			if err == nil {
				t.Errorf("Parse(%q) = %s, want an error", tc.in, got)
			}
			continue
		}
		if err != nil || got.Kind() != tc.kind || got.String() != tc.in {
			t.Errorf("Parse(%q) = %s (%s), %v; want kind %s", tc.in, got, got.Kind(), err, tc.kind)
		}
	}
	if _, err := ref.ParseMessage("content:" + hex(16)); err == nil {
		t.Error("ParseMessage accepted a content ref")
	}
	if _, err := ref.ParseContent("msg:" + hex(16)); err == nil {
		t.Error("ParseContent accepted a message ref")
	}
}

func TestForMessageHashesWhichIdentifierKeysIt(t *testing.T) {
	byExternalID := ref.ForMessage("gmail", "", "<a@example.com>")
	byMessageID := ref.ForMessage("gmail", "<a@example.com>", "18c0ffee")
	if byExternalID == byMessageID {
		t.Fatalf("an external id and a Message-ID with the same text share %s", byExternalID)
	}
	if parsed, err := ref.ParseMessage(byMessageID.String()); err != nil || parsed != byMessageID {
		t.Fatalf("ParseMessage(%s) = %s, %v", byMessageID, parsed, err)
	}
}

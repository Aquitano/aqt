package discord

import (
	"strings"
	"testing"
)

func TestParseCSV(t *testing.T) {
	csvData := `ID,Timestamp,Contents,Attachments
805970292,2021-05-06 12:34:56.789000+00:00,"hey, want to play?",
805970293,2021-05-06 12:35:10,,https://cdn.discordapp.com/attachments/1/2/img.png
`
	msgs, err := parseCSV(strings.NewReader(csvData), "Direct Message with alice")
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want 2", len(msgs))
	}
	if msgs[0].Body != "hey, want to play?" || msgs[0].ID != "805970292" {
		t.Errorf("first = %+v", msgs[0])
	}
	if msgs[0].SentAt.Year() != 2021 || msgs[0].SentAt.Hour() != 12 {
		t.Errorf("timestamp = %v", msgs[0].SentAt)
	}
	if !strings.HasPrefix(msgs[1].Body, "[attachment] https://") {
		t.Errorf("attachment-only row body = %q", msgs[1].Body)
	}
}

func TestParseJSON(t *testing.T) {
	jsonData := `[{"ID": 805970292, "Timestamp": "2024-01-02T10:20:30.400000+00:00", "Contents": "newer package", "Attachments": ""}]`
	msgs, err := parseJSON([]byte(jsonData), "general")
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 || msgs[0].Body != "newer package" || msgs[0].ID != "805970292" {
		t.Fatalf("msgs = %+v", msgs)
	}
	if msgs[0].SentAt.Year() != 2024 {
		t.Errorf("timestamp = %v", msgs[0].SentAt)
	}
}

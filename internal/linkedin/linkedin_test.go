package linkedin

import (
	"strings"
	"testing"
)

func TestParseCSV(t *testing.T) {
	csvData := `CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER
2-abc123,,Jane Recruiter,https://linkedin.com/in/jane,Thomas Breindl,https://linkedin.com/in/thomas,2023-05-13 21:08:45 UTC,Opportunity at Acme,"Hi Thomas,
are you open to a new role?",INBOX
2-abc123,,Thomas Breindl,https://linkedin.com/in/thomas,Jane Recruiter,https://linkedin.com/in/jane,2023-05-14 08:00:00 UTC,,,ARCHIVE
`
	msgs, err := parseCSV(strings.NewReader(csvData))
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want 2", len(msgs))
	}
	m := msgs[0]
	if m.From != "Jane Recruiter" || m.Subject != "Opportunity at Acme" {
		t.Errorf("first = %+v", m)
	}
	if !strings.Contains(m.Body, "open to a new role") {
		t.Errorf("multiline body = %q", m.Body)
	}
	if m.SentAt.Year() != 2023 || m.SentAt.Hour() != 21 {
		t.Errorf("date = %v", m.SentAt)
	}
	if m.Thread != "2-abc123" {
		t.Errorf("thread fallback = %q", m.Thread)
	}
	if msgs[1].Body != "" || msgs[1].Subject != "" {
		t.Errorf("second should be empty content: %+v", msgs[1])
	}
}

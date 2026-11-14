package generic

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/library"
)

type collect struct {
	messages []ingest.Message
	issues   []ingest.Issue
}

func (c *collect) Message(m ingest.Message) error {
	c.messages = append(c.messages, m)
	return nil
}
func (c *collect) Library(library.ImportBatch) error { return nil }
func (c *collect) Pages(ingest.Pages) error          { return nil }
func (c *collect) Issue(i ingest.Issue)              { c.issues = append(c.issues, i) }

func parse(t *testing.T, input string) (*collect, error) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "input")
	if err := os.WriteFile(path, []byte(input), 0o600); err != nil {
		t.Fatal(err)
	}
	out := &collect{}
	err := Source{}.Parse(context.Background(), ingest.Raw{Name: "input.json", Path: path}, Options{Source: "notes"}, out)
	return out, err
}

func TestParseArrayAndNDJSON(t *testing.T) {
	array := `[{"source":"notes","body":"one"},{"source":"notes","body":"two"}]`
	ndjson := "{\"source\":\"notes\",\"body\":\"one\"}\n{\"source\":\"notes\",\"body\":\"two\"}\n"
	for _, input := range []string{array, ndjson} {
		out, err := parse(t, input)
		if err != nil {
			t.Fatal(err)
		}
		if len(out.messages) != 2 || out.messages[0].Body != "one" || out.messages[1].Body != "two" {
			t.Fatalf("messages = %+v", out.messages)
		}
	}
}

func TestDerivedIDStableWithoutSentAt(t *testing.T) {
	e := entry{Source: "notes", Body: "buy milk"}
	first := derivedID(e, "", map[string]int{})
	second := derivedID(e, "", map[string]int{})
	if first != second {
		t.Error("id without sent_at must not depend on import time")
	}
	seen := map[string]int{}
	a, b := derivedID(e, "", seen), derivedID(e, "", seen)
	if a == b {
		t.Error("duplicate entries in one batch collided")
	}
	seen2 := map[string]int{}
	if derivedID(e, "", seen2) != a || derivedID(e, "", seen2) != b {
		t.Error("batch counter not reproducible across re-imports")
	}
}

func TestZonelessSentAtIDsIgnoreMachineZone(t *testing.T) {
	input := `[{"body":"standup","sent_at":"2024-05-13 21:08:00"},{"body":"standup","sent_at":"2024-05-13"},{"body":"standup","sent_at":"2024-05-13"}]`
	local := time.Local
	t.Cleanup(func() { time.Local = local })
	var runs [][]ingest.Message
	for _, zone := range []*time.Location{time.FixedZone("east", 9*3600), time.FixedZone("west", -7*3600)} {
		time.Local = zone
		out, err := parse(t, input)
		if err != nil || len(out.messages) != 3 {
			t.Fatalf("%s: %d messages, %v", zone, len(out.messages), err)
		}
		runs = append(runs, out.messages)
	}
	for i := range runs[0] {
		a, b := runs[0][i], runs[1][i]
		if a.ExternalID != b.ExternalID || !a.SentAt.Equal(b.SentAt) {
			t.Errorf("entry %d differs between zones: %s %v, %s %v", i, a.ExternalID, a.SentAt, b.ExternalID, b.SentAt)
		}
	}
}

func TestParseSentAt(t *testing.T) {
	for raw, want := range map[string]time.Time{
		`"2024-05-13T21:08:00Z"`:      time.Date(2024, 5, 13, 21, 8, 0, 0, time.UTC),
		`"2024-05-13T23:08:00+02:00"`: time.Date(2024, 5, 13, 21, 8, 0, 0, time.UTC),
		`"2024-05-13 21:08:00"`:       time.Date(2024, 5, 13, 21, 8, 0, 0, time.UTC),
		`"2024-05-13"`:                time.Date(2024, 5, 13, 0, 0, 0, 0, time.UTC),
		`1715629680`:                  time.Unix(1715629680, 0),
	} {
		got, key, err := parseSentAt([]byte(raw))
		if err != nil {
			t.Errorf("%s: %v", raw, err)
			continue
		}
		if !got.Equal(want) {
			t.Errorf("%s = %v, want %v", raw, got, want)
		}
		if want := strings.Trim(raw, `"`); key != want {
			t.Errorf("%s hashes as %q, want %q", raw, key, want)
		}
	}
	for _, raw := range []string{"", "null"} {
		if got, key, err := parseSentAt([]byte(raw)); err != nil || !got.IsZero() || key != "" {
			t.Errorf("sent_at %q: got %v %q, %v", raw, got, key, err)
		}
	}
	if _, _, err := parseSentAt([]byte(`"yesterday-ish"`)); err == nil {
		t.Error("garbage sent_at should error")
	}
}

func TestParseRejectsTrailingData(t *testing.T) {
	bad := map[string]string{
		"second value":  `[{"body":"one"}] {"body":"two"}`,
		"garbage":       `[{"body":"one"}] nonsense`,
		"second array":  `[{"body":"one"}][{"body":"two"}]`,
		"stray bracket": `[{"body":"one"}]]`,
	}
	for name, input := range bad {
		t.Run(name, func(t *testing.T) {
			if _, err := parse(t, input); err == nil {
				t.Fatalf("accepted %q", input)
			}
		})
	}

	good := map[string]int{
		`[{"body":"one"}]`:                       1,
		"[{\"body\":\"one\"}]\n\n  \t\n":         1,
		`{"body":"one"}`:                         1,
		"{\"body\":\"one\"}\n{\"body\":\"two\"}": 2,
		`[]`:                                     0,
		"":                                       0,
	}
	for input, want := range good {
		out, err := parse(t, input)
		if err != nil {
			t.Errorf("%q: %v", input, err)
			continue
		}
		if len(out.messages) != want {
			t.Errorf("%q: got %d messages, want %d", input, len(out.messages), want)
		}
	}
}

func TestInvalidEntriesAreRejected(t *testing.T) {
	entries := []string{
		`{"body":"ok"}`,
		`{"source":"../escape","body":"x"}`,
		`{"subject":""}`,
		`{"body":"x","sent_at":"yesterday-ish"}`,
		`{"body":"x","attachments":[{"path":"/etc/passwd"}]}`,
		`{"body":"x","attachments":[{"data":"UERG"}]}`,
		`{"body":"x","attachments":[{"filename":"a.pdf","data":"not base64!"}]}`,
	}
	input, err := json.Marshal(rawValues(entries))
	if err != nil {
		t.Fatal(err)
	}
	out, err := parse(t, string(input))
	if err != nil {
		t.Fatal(err)
	}
	if len(out.messages) != 1 || out.messages[0].Source != "notes" || out.messages[0].Locator != "entry 0" {
		t.Fatalf("messages = %+v", out.messages)
	}
	if len(out.issues) != len(entries)-1 {
		t.Fatalf("issues = %+v", out.issues)
	}
	for _, issue := range out.issues {
		if issue.Kind != ingest.Rejected {
			t.Errorf("issue %+v is not rejected", issue)
		}
	}
	if !strings.HasPrefix(out.issues[0].Detail, "entry 1:") {
		t.Errorf("first issue does not name its entry: %q", out.issues[0].Detail)
	}
}

func rawValues(values []string) []json.RawMessage {
	out := make([]json.RawMessage, len(values))
	for i, v := range values {
		out[i] = json.RawMessage(v)
	}
	return out
}

func TestOptionsNormalize(t *testing.T) {
	o := Options{}
	if err := o.Normalize(); err != nil || o.Source != "json" {
		t.Errorf("default source: %+v, %v", o, err)
	}
	o = Options{Source: "../escape"}
	if err := o.Normalize(); err == nil {
		t.Error("a traversal source was accepted")
	}
}

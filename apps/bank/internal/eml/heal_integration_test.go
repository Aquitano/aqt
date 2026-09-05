package eml

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

// seedStub archives raw under source and inserts the row an older parser would
// have written for it: the same identity, a body that is only the stub.
func seedStub(t *testing.T, st *store.Store, archiveDir, source, name, messageID, raw, body string) string {
	t.Helper()
	dir := filepath.Join(archiveDir, source)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	id, err := st.InsertMessage(context.Background(), store.Message{
		Source: source, ExternalID: messageID, MessageID: messageID,
		Sender: "bank@example.com", Subject: "Dauerauftrag", Body: body,
		SentAt: time.Date(2024, 5, 13, 21, 8, 0, 0, time.UTC), RawRef: filepath.Join(source, name),
	})
	if err != nil || id == 0 {
		t.Fatalf("seed %s: %d %v", messageID, id, err)
	}
	return filepath.Join(source, name)
}

func bodyOf(t *testing.T, st *store.Store, source, messageID string) string {
	t.Helper()
	ctx := context.Background()
	id, err := st.FindByEmailMessageID(ctx, source, messageID)
	if err != nil || id == 0 {
		t.Fatalf("message %s not found: %d %v", messageID, id, err)
	}
	body, err := st.MessageBody(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

// The mail that motivated the pass: imported when body() still preferred any
// plain part, so the row holds a template and the HTML the sender wrote lives
// only in the archived raw.
func TestHealBodiesReplacesStubsFromTheArchive(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	archiveDir := filepath.Join(t.TempDir(), "archive")

	stub := stubMail("dauerauftrag@example.com")
	seedStub(t, st, archiveDir, "gmail", "abc123456789-All mail.mbox",
		"dauerauftrag@example.com", "From bank@example.com Mon May 13 21:08:00 2024\n"+stub,
		StripHTML(stubPlain))
	// A message whose stored body is already the full text: the pass must read
	// it and leave it alone.
	intact := stubMail("intact@example.com")
	seedStub(t, st, archiveDir, "gmail", "def123456789-intact.eml", "intact@example.com",
		intact, StripHTML(stubHTML))

	var heals []BodyHeal
	collect := func(h BodyHeal) { heals = append(heals, h) }

	res, err := HealBodies(ctx, st, archiveDir, "gmail", false, collect)
	if err != nil {
		t.Fatal(err)
	}
	if res.Files != 2 || res.Messages != 2 || res.Matched != 2 || res.Healed != 1 {
		t.Fatalf("dry run = %+v, want exactly the stub found", res)
	}
	if len(heals) != 1 || heals[0].Applied {
		t.Fatalf("heals = %+v, want one candidate, written by nobody", heals)
	}
	if h := heals[0]; h.Reparsed <= h.Stored || h.Subject != "Dauerauftrag" ||
		h.Ref != filepath.Join("gmail", "abc123456789-All mail.mbox") {
		t.Errorf("heal = %+v", h)
	}
	if body := bodyOf(t, st, "gmail", "dauerauftrag@example.com"); strings.Contains(body, "450,00 EUR") {
		t.Fatal("a dry run wrote the body")
	}

	heals = nil
	res, err = HealBodies(ctx, st, archiveDir, "gmail", true, collect)
	if err != nil {
		t.Fatal(err)
	}
	if res.Healed != 1 || !res.Applied {
		t.Fatalf("apply = %+v", res)
	}
	if len(heals) != 1 || !heals[0].Applied {
		t.Fatalf("heals = %+v, want one written", heals)
	}
	body := bodyOf(t, st, "gmail", "dauerauftrag@example.com")
	if !strings.Contains(body, "Dauerauftrag ueber 450,00 EUR") {
		t.Errorf("body = %q, want the text the sender actually wrote", body)
	}
	if got := bodyOf(t, st, "gmail", "intact@example.com"); got != StripHTML(stubHTML) {
		t.Errorf("an already-complete body changed: %q", got)
	}

	// Idempotent: the second pass finds the bodies equal and reports nothing.
	heals = nil
	res, err = HealBodies(ctx, st, archiveDir, "gmail", true, collect)
	if err != nil {
		t.Fatal(err)
	}
	if res.Healed != 0 || len(heals) != 0 {
		t.Fatalf("a second pass changed something: %+v %+v", res, heals)
	}
}

// Raws under a source that are not mail, and mail belonging to another source,
// are both outside the pass: it must not guess at a WhatsApp export and must
// not match a proton mail against a gmail row.
func TestHealBodiesStaysWithinMailOfOneSource(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	archiveDir := filepath.Join(t.TempDir(), "archive")

	seedStub(t, st, archiveDir, "gmail", "abc123456789-mail.eml", "elsewhere@example.com",
		stubMail("elsewhere@example.com"), StripHTML(stubPlain))
	if err := os.WriteFile(filepath.Join(archiveDir, "gmail", "abc123456789-chat.zip"), []byte("PK\x03\x04"), 0o600); err != nil {
		t.Fatal(err)
	}

	res, err := HealBodies(ctx, st, archiveDir, "proton", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Files != 0 || res.Healed != 0 {
		t.Fatalf("another source was touched: %+v", res)
	}
	if body := bodyOf(t, st, "gmail", "elsewhere@example.com"); strings.Contains(body, "450,00 EUR") {
		t.Fatal("a proton pass healed a gmail row")
	}

	res, err = HealBodies(ctx, st, archiveDir, "gmail", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Files != 1 || res.Healed != 1 {
		t.Fatalf("res = %+v, want the .eml read and the .zip skipped", res)
	}
}

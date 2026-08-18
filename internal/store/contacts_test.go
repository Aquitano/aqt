package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aquitano/aqt-bank/internal/store"
	"github.com/aquitano/aqt-bank/internal/storetest"
)

// seedPeople writes the same person under the three spellings three sources
// would record, plus an unrelated person.
func seedPeople(t *testing.T, st *store.Store) {
	t.Helper()
	ctx := context.Background()
	msgs := []store.Message{
		{Source: "gmail", ExternalID: "g1", Sender: "Björn <bjoern@example.com>",
			Recipients: []string{"thomas@example.com"}, Subject: "invoice", Body: "the hetzner invoice"},
		{Source: "gmail", ExternalID: "g2", Sender: "thomas@example.com",
			Recipients: []string{"Björn <bjoern@example.com>"}, Subject: "re: invoice", Body: "paid it"},
		{Source: "whatsapp", ExternalID: "w1", ThreadID: "Björn", Sender: "Björn", Body: "did you see the invoice"},
		{Source: "discord", ExternalID: "d1", Sender: "bjoern_aq", Body: "invoice sorted"},
		{Source: "whatsapp", ExternalID: "w2", ThreadID: "Carol", Sender: "Carol", Body: "unrelated invoice talk"},
	}
	for _, m := range msgs {
		m.SentAt = time.Date(2024, 5, 13, 21, 8, 0, 0, time.UTC)
		if _, err := st.InsertMessage(ctx, m); err != nil {
			t.Fatal(err)
		}
	}
}

func TestContactResolvesOnePersonAcrossSources(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	seedPeople(t, st)

	if _, err := st.CreateContact(ctx, "bjoern", "the one with the servers"); err != nil {
		t.Fatal(err)
	}
	// One address, one display name, one handle: three sources, one person.
	for _, alias := range []struct{ source, value string }{
		{"", "bjoern@example.com"},
		{"whatsapp", "Björn"},
		{"discord", "bjoern_aq"},
	} {
		if _, err := st.AddAlias(ctx, "bjoern", alias.source, alias.value); err != nil {
			t.Fatalf("add %q: %v", alias.value, err)
		}
	}

	msgs, err := st.ContactMessages(ctx, "bjoern", store.ContactMessagesOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 4 {
		t.Fatalf("got %d messages, want the 4 that are theirs: %+v", len(msgs), ids(msgs))
	}
	seen := map[string]bool{}
	for _, m := range msgs {
		seen[m.Source] = true
		if m.Body == "unrelated invoice talk" {
			t.Error("another person's message was attributed to this contact")
		}
	}
	if len(seen) != 3 {
		t.Errorf("sources = %v, want gmail, whatsapp and discord", seen)
	}

	counts, err := st.ContactSourceCounts(ctx, contactID(t, st, "bjoern"))
	if err != nil {
		t.Fatal(err)
	}
	if len(counts) != 3 {
		t.Fatalf("counts = %+v", counts)
	}

	t.Run("matched as a recipient too", func(t *testing.T) {
		// g2 is addressed *to* them, not from them.
		var found bool
		for _, m := range msgs {
			if m.ExternalID == "g2" {
				found = true
			}
		}
		if !found {
			t.Error("a message addressed to the contact was not matched")
		}
	})

	t.Run("search --person spans sources", func(t *testing.T) {
		got, err := st.Search(ctx, "invoice", store.SearchOpts{Limit: 20, Fuzzy: 0, Person: "bjoern"})
		if err != nil {
			t.Fatal(err)
		}
		if len(got) < 2 {
			t.Fatalf("got %d results: %+v", len(got), ids(got))
		}
		for _, m := range got {
			if m.Sender == "Carol" {
				t.Error("--person let another person's message through")
			}
		}
	})

	t.Run("an unknown person is a usage error", func(t *testing.T) {
		if _, err := st.Search(ctx, "invoice", store.SearchOpts{Limit: 20, Person: "nobody"}); err == nil {
			t.Error("searching for an unknown contact should say so, not return nothing")
		}
	})
}

func TestAliasScopeNarrowsToOneSource(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	seedPeople(t, st)
	if _, err := st.CreateContact(ctx, "wa-only", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddAlias(ctx, "wa-only", "whatsapp", "Björn"); err != nil {
		t.Fatal(err)
	}
	msgs, err := st.ContactMessages(ctx, "wa-only", store.ContactMessagesOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 || msgs[0].Source != "whatsapp" {
		t.Fatalf("a whatsapp-scoped alias reached other sources: %+v", ids(msgs))
	}
}

func TestAliasConflictsAreRefusedWithTheOwnersName(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	for _, name := range []string{"a", "b"} {
		if _, err := st.CreateContact(ctx, name, ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.AddAlias(ctx, "a", "", "shared@example.com"); err != nil {
		t.Fatal(err)
	}

	cases := map[string]string{
		"same global scope":     "",
		"scoped under a global": "whatsapp",
	}
	for name, source := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := st.AddAlias(ctx, "b", source, "shared@example.com")
			var conflict *store.ErrConflict
			if !errors.As(err, &conflict) {
				t.Fatalf("err = %v, want a conflict", err)
			}
			if conflict.Owner != "a" {
				t.Errorf("conflict names %q, want the contact that has it", conflict.Owner)
			}
		})
	}

	t.Run("different sources do not overlap", func(t *testing.T) {
		if _, err := st.AddAlias(ctx, "a", "whatsapp", "Alice"); err != nil {
			t.Fatal(err)
		}
		if _, err := st.AddAlias(ctx, "b", "discord", "Alice"); err != nil {
			t.Errorf("one display name in two sources should be two people: %v", err)
		}
	})
}

func TestRemovingAnAliasFullyReversesTheAttribution(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	seedPeople(t, st)
	if _, err := st.CreateContact(ctx, "bjoern", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddAlias(ctx, "bjoern", "", "bjoern@example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddAlias(ctx, "bjoern", "whatsapp", "Björn"); err != nil {
		t.Fatal(err)
	}
	before, err := st.ContactMessages(ctx, "bjoern", store.ContactMessagesOpts{})
	if err != nil || len(before) != 3 {
		t.Fatalf("before = %v, err = %v", ids(before), err)
	}

	if err := st.RemoveAlias(ctx, "bjoern", "whatsapp", "Björn"); err != nil {
		t.Fatal(err)
	}
	after, err := st.ContactMessages(ctx, "bjoern", store.ContactMessagesOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 2 {
		t.Fatalf("after = %v, want the whatsapp message detached", ids(after))
	}

	// The source's own record of who sent it is untouched — that is what makes
	// a wrong attachment recoverable rather than destructive.
	m, _, err := st.GetMessage(ctx, before[len(before)-1].ID)
	if err != nil {
		t.Fatal(err)
	}
	if m.Sender == "" {
		t.Error("the original sender was modified")
	}
	if err := st.RemoveAlias(ctx, "bjoern", "whatsapp", "Björn"); err == nil {
		t.Error("removing an absent alias should say so")
	}

	// Deleting the contact leaves every message in place.
	if err := st.DeleteContact(ctx, "bjoern"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetContact(ctx, "bjoern"); err != store.ErrNotFound {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
	msgs, err := st.Search(ctx, "invoice", store.SearchOpts{Limit: 20, Fuzzy: 0})
	if err != nil || len(msgs) == 0 {
		t.Fatalf("messages did not survive deleting the contact: %d, %v", len(msgs), err)
	}
}

func TestSuggestRanksUnattachedIdentities(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	seedPeople(t, st)

	got, err := st.SuggestIdentities(ctx, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) == 0 {
		t.Fatal("no suggestions from a seeded archive")
	}
	found := map[string]store.IdentitySuggestion{}
	for _, s := range got {
		found[s.Identity] = s
	}
	if _, ok := found["bjoern@example.com"]; !ok {
		t.Fatalf("the most frequent identity is missing: %+v", got)
	}
	if s := found["bjoern@example.com"]; len(s.Sources) == 0 || len(s.Samples) == 0 {
		t.Errorf("a suggestion needs context to act on: %+v", s)
	}

	// Once attached, an identity stops being suggested — otherwise the list
	// never shrinks as the contact book fills up.
	if _, err := st.CreateContact(ctx, "bjoern", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddAlias(ctx, "bjoern", "", "bjoern@example.com"); err != nil {
		t.Fatal(err)
	}
	got, err = st.SuggestIdentities(ctx, 20)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range got {
		if s.Identity == "bjoern@example.com" {
			t.Error("an attached identity is still being suggested")
		}
	}
}

func TestContactAliasScope(t *testing.T) {
	known := func(s string) bool { return s == "whatsapp" || s == "discord" }
	cases := map[string][2]string{
		"whatsapp:Björn":     {"whatsapp", "Björn"},
		"discord:bjoern_aq":  {"discord", "bjoern_aq"},
		"bjoern@example.com": {"", "bjoern@example.com"},
		"Björn":              {"", "Björn"},
		// Not a known source, so it stays part of the value rather than
		// silently scoping the alias to a source that does not exist.
		"nope:value": {"", "nope:value"},
		"whatsapp:":  {"", "whatsapp:"},
	}
	for input, want := range cases {
		source, value := store.ContactAliasScope(input, known)
		if source != want[0] || value != want[1] {
			t.Errorf("%q -> (%q, %q), want (%q, %q)", input, source, value, want[0], want[1])
		}
	}
}

func ids(msgs []store.Message) []string {
	out := make([]string, len(msgs))
	for i, m := range msgs {
		out[i] = m.Source + "/" + m.ExternalID
	}
	return out
}

func contactID(t *testing.T, st *store.Store, name string) int64 {
	t.Helper()
	c, err := st.GetContact(context.Background(), name)
	if err != nil {
		t.Fatal(err)
	}
	return c.ID
}

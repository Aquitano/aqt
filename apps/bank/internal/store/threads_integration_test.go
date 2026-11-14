package store_test

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestThreadPagesAcrossEqualTimestamps(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	var messages []store.Message
	for i := range 11 {
		messages = append(messages, msg("chat", "m"+fmt.Sprint(i), store.Message{ThreadID: "t", Body: "hello", SentAt: time.Unix(1, 0)}))
	}
	ids, err := st.InsertMessages(ctx, messages)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.InsertAttachment(ctx, store.Attachment{MessageID: ids[8], Filename: "anything.bin", BLAKE3: content.Sum([]byte("a"))}); err != nil {
		t.Fatal(err)
	}
	eighth := ref.ForMessage("chat", "", "m8")
	around, err := st.GetThreadPage(ctx, "chat", "t", store.ThreadOpts{Around: eighth, Limit: 3})
	if err != nil {
		t.Fatal(err)
	}
	if len(around.Messages) != 3 || around.Messages[1].Ref != eighth.String() || len(around.Messages[1].Attachments) != 1 || !around.HasBefore || !around.HasAfter {
		t.Fatalf("context=%+v", around)
	}
	for _, backward := range []bool{false, true} {
		o := store.ThreadOpts{Limit: 3, Latest: backward}
		seen := map[string]bool{}
		for {
			page, err := st.GetThreadPage(ctx, "chat", "t", o)
			if err != nil {
				t.Fatal(err)
			}
			for i, m := range page.Messages {
				if seen[m.Ref] {
					t.Fatalf("repeated message %s", m.Ref)
				}
				seen[m.Ref] = true
				if i > 0 && page.Messages[i-1].ID >= m.ID {
					t.Fatal("page not chronological")
				}
			}
			if backward {
				if !page.HasBefore {
					break
				}
				o = store.ThreadOpts{Limit: 3, Before: messageRef(t, page.Messages[0].Ref)}
			} else {
				if !page.HasAfter {
					break
				}
				o = store.ThreadOpts{Limit: 3, After: messageRef(t, page.Messages[len(page.Messages)-1].Ref)}
			}
		}
		if len(seen) != len(ids) {
			t.Fatalf("visited %d, want %d", len(seen), len(ids))
		}
	}
	if _, err := st.InsertMessage(ctx, msg("chat", "other", store.Message{ThreadID: "other", Body: "private"})); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetThreadPage(ctx, "chat", "t", store.ThreadOpts{Around: ref.ForMessage("chat", "", "other")}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("foreign cursor accepted: %v", err)
	}
	first, second := ref.ForMessage("chat", "", "m0"), ref.ForMessage("chat", "", "m1")
	for _, o := range []store.ThreadOpts{{Before: first, After: second}, {Limit: 2001}, {Latest: true, Around: first}} {
		if _, err := st.GetThreadPage(ctx, "chat", "t", o); err == nil {
			t.Fatalf("accepted invalid opts %+v", o)
		}
	}
}

// Browse pages by keyset: each page continues after the previous page's last
// thread, so no thread repeats or is skipped, even when a thread's messages
// straddle the page boundary. A message without a thread is its own group.
func TestBrowsePagesEveryThreadOnce(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	start := time.Date(2024, 5, 1, 0, 0, 0, 0, time.UTC)
	threads := []string{"", "a", "b", "", "a", "c", "b", "msg:1", "a", "", "d", "c"}
	for i, thread := range threads {
		if _, err := st.InsertMessage(ctx, msg("chat", fmt.Sprint(i), store.Message{ThreadID: thread, Body: "hello",
			SentAt: start.Add(time.Duration(i) * time.Minute)})); err != nil {
			t.Fatal(err)
		}
	}
	var order []string
	counts := map[string]int64{}
	var after ref.Message
	for range len(threads) {
		groups, err := st.BrowseThreads(ctx, store.BrowseOpts{Limit: 2, After: after})
		if err != nil {
			t.Fatal(err)
		}
		if len(groups) == 0 {
			break
		}
		for _, g := range groups {
			key := cmp.Or(g.ThreadID, g.LastRef)
			if _, seen := counts[key]; seen {
				t.Fatalf("thread %s repeated", key)
			}
			order, counts[key] = append(order, key), g.Count
		}
		after = messageRef(t, groups[len(groups)-1].LastRef)
	}
	// Newest last message first: c (11), d (10), the untitled 9, a (8),
	// msg:1 (7), b (6), the untitled 3 and 0.
	if len(order) != 8 || order[0] != "c" || order[1] != "d" || order[3] != "a" || order[5] != "b" {
		t.Fatalf("threads in order %q", order)
	}
	if counts["a"] != 3 || counts["b"] != 2 || counts["c"] != 2 {
		t.Fatalf("counts %v", counts)
	}
}

func TestContactHistoryCursor(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	seedIdentical(t, st, 7)
	if _, err := st.CreateContact(ctx, "alice", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddAlias(ctx, "alice", "", "alice@example.com"); err != nil {
		t.Fatal(err)
	}
	first, err := st.ContactMessages(ctx, "alice", store.ContactMessagesOpts{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	attachmentID := first[0].ID
	if err := st.InsertAttachment(ctx, store.Attachment{MessageID: attachmentID, Filename: "recording.wav", BLAKE3: content.Sum([]byte("a"))}); err != nil {
		t.Fatal(err)
	}
	seen := map[int64]bool{}
	var before ref.Message
	for {
		page, err := st.ContactMessages(ctx, "alice", store.ContactMessagesOpts{Limit: 2, Before: before})
		if err != nil {
			t.Fatal(err)
		}
		if len(page) == 0 {
			break
		}
		for _, m := range page {
			if m.ID == attachmentID && (len(m.Attachments) != 1 || m.Attachments[0].Filename != "recording.wav") {
				t.Fatal("contact history lost its attachment")
			}
			if seen[m.ID] {
				t.Fatal("contact page repeated")
			}
			seen[m.ID] = true
		}
		before = messageRef(t, page[len(page)-1].Ref)
	}
	if len(seen) != 7 {
		t.Fatalf("visited %d messages", len(seen))
	}
}

func TestBrowseMembersExcludeOwner(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	for i, sender := range []string{"Thomas", "THOMAS BREINDL", "Alice", "Bob", "Alice"} {
		if _, err := st.InsertMessage(ctx, msg("whatsapp", fmt.Sprint(i), store.Message{ThreadID: "123@g.us", Sender: sender, Body: "hello"})); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.CreateContact(ctx, "me", ""); err != nil {
		t.Fatal(err)
	}
	for _, alias := range []string{"Thomas", "Thomas Breindl"} {
		if _, err := st.AddAlias(ctx, "me", "whatsapp", alias); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.SetSelf(ctx, "me"); err != nil {
		t.Fatal(err)
	}
	groups, err := st.BrowseThreads(ctx, store.BrowseOpts{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 1 || groups[0].Members != "Alice, Bob" {
		t.Fatalf("browse groups=%+v", groups)
	}
}

func messageRef(t *testing.T, s string) ref.Message {
	t.Helper()
	cited, err := ref.ParseMessage(s)
	if err != nil {
		t.Fatal(err)
	}
	return cited
}

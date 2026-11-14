package store_test

import (
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

func TestBrowseKeepsUntitledMessagesSeparate(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	for i, thread := range []string{"", "", "same", "same", "msg:1"} {
		if _, err := st.InsertMessage(ctx, msg("chat", fmt.Sprint(i), store.Message{ThreadID: thread, Body: "hello"})); err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]bool{}
	for offset := 0; offset < 4; offset += 2 {
		groups, err := st.BrowseThreads(ctx, store.BrowseOpts{Limit: 2, Offset: offset})
		if err != nil {
			t.Fatal(err)
		}
		for _, g := range groups {
			if seen[g.LastRef] {
				t.Fatal("repeated browse group")
			}
			seen[g.LastRef] = true
		}
	}
	if len(seen) != 4 {
		t.Fatalf("groups=%v", seen)
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

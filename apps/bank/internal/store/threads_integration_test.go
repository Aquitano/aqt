package store_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

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
	ids, err := st.InsertMessages(ctx, messages, store.InsertMessagesOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.InsertAttachment(ctx, store.Attachment{MessageID: ids[8], Filename: "anything.bin", SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}); err != nil {
		t.Fatal(err)
	}
	around, err := st.GetThreadPage(ctx, "chat", "t", store.ThreadOpts{Around: ids[8], Limit: 3})
	if err != nil {
		t.Fatal(err)
	}
	if len(around.Messages) != 3 || around.Messages[1].ID != ids[8] || len(around.Messages[1].Attachments) != 1 || !around.HasBefore || !around.HasAfter {
		t.Fatalf("context=%+v", around)
	}
	for _, backward := range []bool{false, true} {
		o := store.ThreadOpts{Limit: 3, Latest: backward}
		seen := map[int64]bool{}
		for {
			page, err := st.GetThreadPage(ctx, "chat", "t", o)
			if err != nil {
				t.Fatal(err)
			}
			for i, m := range page.Messages {
				if seen[m.ID] {
					t.Fatalf("repeated message %d", m.ID)
				}
				seen[m.ID] = true
				if i > 0 && page.Messages[i-1].ID >= m.ID {
					t.Fatal("page not chronological")
				}
			}
			if backward {
				if !page.HasBefore {
					break
				}
				o = store.ThreadOpts{Limit: 3, Before: page.Messages[0].ID}
			} else {
				if !page.HasAfter {
					break
				}
				o = store.ThreadOpts{Limit: 3, After: page.Messages[len(page.Messages)-1].ID}
			}
		}
		if len(seen) != len(ids) {
			t.Fatalf("visited %d, want %d", len(seen), len(ids))
		}
	}
	other, err := st.InsertMessage(ctx, msg("chat", "other", store.Message{ThreadID: "other", Body: "private"}))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetThreadPage(ctx, "chat", "t", store.ThreadOpts{Around: other}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("foreign cursor accepted: %v", err)
	}
	for _, o := range []store.ThreadOpts{{Before: ids[0], After: ids[1]}, {Around: -1}, {Limit: 2001}, {Latest: true, Around: ids[0]}} {
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
	seen := map[int64]bool{}
	for offset := 0; offset < 4; offset += 2 {
		groups, err := st.BrowseThreads(ctx, store.BrowseOpts{Limit: 2, Offset: offset})
		if err != nil {
			t.Fatal(err)
		}
		for _, g := range groups {
			if seen[g.LastID] {
				t.Fatal("repeated browse group")
			}
			seen[g.LastID] = true
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
	if err := st.InsertAttachment(ctx, store.Attachment{MessageID: attachmentID, Filename: "recording.wav", SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}); err != nil {
		t.Fatal(err)
	}
	seen := map[int64]bool{}
	var before int64
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
		before = page[len(page)-1].ID
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

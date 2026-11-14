package store_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

// The derivation is a contract with every note that ever cited a message, so
// its output is pinned here as values rather than recomputed: changing it
// silently repoints old citations.
const (
	goldenSource  = "claude"
	goldenKey     = "e33e84ec-61be-48d5-ad97-bbfb3da5bcf4"
	goldenRef     = "msg:9454d9440ade1088"
	goldenMailRef = "msg:4a8e1445b83f809c"
)

func TestRefIsStableAndAddressable(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)

	if _, err := st.InsertMessage(ctx, msg(goldenSource, goldenKey, store.Message{
		ThreadID: "t1", Sender: "assistant", Body: "quarterly numbers attached",
	})); err != nil {
		t.Fatal(err)
	}
	// Mail is keyed by its RFC 822 Message-ID where it has one, which is what
	// survives a re-import under a different provider id.
	if _, err := st.InsertMessage(ctx, msg("gmail", "provider-id-1", store.Message{
		MessageID: "abc123@example.com", ThreadID: "t2",
		Sender: "alice@example.com", Body: "quarterly numbers attached",
	})); err != nil {
		t.Fatal(err)
	}

	m, _, err := st.GetMessage(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if m.Ref != goldenRef {
		t.Fatalf("GetMessage ref = %q, want %q", m.Ref, goldenRef)
	}
	golden, err := ref.ParseMessage(goldenRef)
	if err != nil {
		t.Fatal(err)
	}

	t.Run("mail hashes its message-id", func(t *testing.T) {
		msgs, err := st.Search(ctx, "quarterly", store.SearchOpts{Limit: 20, Fuzzy: 0, Source: "gmail"})
		if err != nil {
			t.Fatal(err)
		}
		if len(msgs) != 1 || msgs[0].Ref != goldenMailRef {
			t.Fatalf("search = %+v, want ref %s", msgs, goldenMailRef)
		}
	})

	t.Run("every read carries the ref", func(t *testing.T) {
		msgs, err := st.Search(ctx, "quarterly", store.SearchOpts{Limit: 20, Fuzzy: 0, Source: goldenSource})
		if err != nil {
			t.Fatal(err)
		}
		if len(msgs) != 1 || msgs[0].Ref != goldenRef {
			t.Fatalf("search = %+v", msgs)
		}
		th, err := st.GetThread(ctx, goldenSource, "t1", 0)
		if err != nil {
			t.Fatal(err)
		}
		if len(th.Messages) != 1 || th.Messages[0].Ref != goldenRef {
			t.Fatalf("thread = %+v", th.Messages)
		}
	})

	t.Run("lookup by ref", func(t *testing.T) {
		d, err := st.GetMessageDetailByRef(ctx, golden)
		if err != nil {
			t.Fatal(err)
		}
		if d.ID != m.ID {
			t.Fatalf("ref resolved to message %d, want %d", d.ID, m.ID)
		}
		absent, err := ref.ParseMessage("msg:0000000000000000")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := st.GetMessageDetailByRef(ctx, absent); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})

	// A different message whose ref is already taken must fail the import, in
	// the single-row path and the batch path alike, rather than be skipped as
	// a duplicate.
	t.Run("a ref collision fails the insert", func(t *testing.T) {
		collider := msg(goldenSource, "collider", store.Message{Body: "not the gmail message"})
		taken := ref.ForMessage(collider.Source, "", collider.ExternalID).String()
		storetest.Exec(t, dsn, `update messages set ref = $1 where source = 'gmail'`, taken)
		for _, batch := range [][]store.Message{{collider}, {collider, msg(goldenSource, "bystander", store.Message{})}} {
			_, err := st.InsertMessages(ctx, batch)
			if err == nil || !strings.Contains(err.Error(), "message ref collision") {
				t.Fatalf("inserting %d messages: err = %v, want a ref collision", len(batch), err)
			}
		}
		if id, err := st.FindMessageID(ctx, goldenSource, "bystander"); err != nil || id != 0 {
			t.Fatalf("the failed batch kept a row: %d, %v", id, err)
		}
	})

	// The point of the ref: a rebuilt archive gives the same message a new row
	// id, and a citation must still find it.
	t.Run("survives a rebuild", func(t *testing.T) {
		rebuilt := storetest.New(t)
		for i := range 3 {
			if _, err := rebuilt.InsertMessage(ctx, msg(goldenSource, fmt.Sprintf("filler-%d", i), store.Message{
				Body: "filler", SentAt: time.Date(2024, 5, 13, 21, 0, i, 0, time.UTC),
			})); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := rebuilt.InsertMessage(ctx, msg(goldenSource, goldenKey, store.Message{
			Sender: "assistant", Body: "quarterly numbers attached",
		})); err != nil {
			t.Fatal(err)
		}
		d, err := rebuilt.GetMessageDetailByRef(ctx, golden)
		if err != nil {
			t.Fatal(err)
		}
		if d.ID == m.ID {
			t.Skip("the rebuilt row landed on the same id; nothing was proved")
		}
		if d.Ref != goldenRef {
			t.Fatalf("ref = %q after rebuild, want %q", d.Ref, goldenRef)
		}
	})
}

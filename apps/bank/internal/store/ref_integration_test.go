package store_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

// goldenRef is a ref the live archive already hands out. The formula is a
// contract with every note that ever cited one, so it is pinned here as a value
// rather than as a description: changing it silently repoints old citations.
const (
	goldenSource = "claude"
	goldenKey    = "e33e84ec-61be-48d5-ad97-bbfb3da5bcf4"
	goldenRef    = "c5e63bfc3750"
)

// wantRef is the formula in Go, so the test fails on a changed SQL expression
// rather than agreeing with whatever the query now computes.
func wantRef(source, key string) string {
	sum := sha256.Sum256([]byte(source + "\x00" + key))
	return hex.EncodeToString(sum[:])[:store.RefChars]
}

func TestRefIsStableAndAddressable(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)

	if got := wantRef(goldenSource, goldenKey); got != goldenRef {
		t.Fatalf("the Go form of the formula drifted: %q, want %q", got, goldenRef)
	}
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

	t.Run("mail hashes its message-id", func(t *testing.T) {
		msgs, err := st.Search(ctx, "quarterly", store.SearchOpts{Limit: 20, Fuzzy: 0, Source: "gmail"})
		if err != nil {
			t.Fatal(err)
		}
		if len(msgs) != 1 {
			t.Fatalf("got %d results", len(msgs))
		}
		if want := wantRef("gmail", "abc123@example.com"); msgs[0].Ref != want {
			t.Fatalf("ref = %q, want %q", msgs[0].Ref, want)
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
		d, err := st.GetMessageDetailByRef(ctx, goldenRef)
		if err != nil {
			t.Fatal(err)
		}
		if d.ID != m.ID {
			t.Fatalf("ref resolved to message %d, want %d", d.ID, m.ID)
		}
		if _, err := st.GetMessageDetailByRef(ctx, "000000000000"); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
		if _, err := st.GetMessageDetailByRef(ctx, "not-a-ref"); err == nil {
			t.Fatal("a malformed ref reached the query")
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
		d, err := rebuilt.GetMessageDetailByRef(ctx, goldenRef)
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

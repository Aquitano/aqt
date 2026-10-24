package server

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/store"
)

func TestRetiredRefResolvesToItsTombstone(t *testing.T) {
	ctx := context.Background()
	c, s := libraryClient(t)
	activity := importWatch(t, s)
	id, err := s.db.InsertMessage(ctx, store.Message{Source: "youtube", ExternalID: "watch:1", Body: "Watched Rust in 100 Seconds", SentAt: time.Date(2026, 8, 14, 9, 12, 33, 0, time.UTC)})
	if err != nil {
		t.Fatal(err)
	}
	m, _, err := s.db.GetMessage(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.RetireMessages(ctx, store.RetireOptions{Source: "youtube", ExternalPrefixes: []string{"watch:"}, Reason: "cutover",
		Replacements: map[string]string{m.Ref: activity.ID}, Apply: true}); err != nil {
		t.Fatal(err)
	}

	_, err = c.GetMessageDetailByRef(ctx, m.Ref)
	retired, ok := errors.AsType[*store.RetiredError](err)
	if !ok {
		t.Fatalf("err = %v, want a retired result", err)
	}
	if got := retired.Retired; got.Ref != m.Ref || got.ExternalID != "watch:1" || got.Replacement != activity.ID || got.Reason != "cutover" || !got.SentAt.Equal(m.SentAt) {
		t.Fatalf("retired = %+v", got)
	}
	if !errors.Is(err, store.ErrNotFound) {
		t.Fatal("a retired ref should still read as no message to callers that only check presence")
	}
}

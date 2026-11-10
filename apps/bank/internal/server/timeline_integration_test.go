package server

import (
	"context"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	atticstore "github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/attic/view"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

type modifiedFiles struct {
	at      time.Time
	content view.Content
	text    string
}

func (m modifiedFiles) ReadText(_ context.Context, blake3 []byte) (string, string, error) {
	if m.text == "" || hex.EncodeToString(blake3) != m.content.BLAKE3 {
		return "", "", atticstore.ErrNotFound
	}
	return m.text, "pdf", nil
}

func (m modifiedFiles) Content(_ context.Context, ref string) (view.Content, error) {
	if ref = strings.TrimPrefix(ref, "attic:"); ref != m.content.Ref && ref != m.content.BLAKE3 {
		return view.Content{}, atticstore.ErrNotFound
	}
	return m.content, nil
}

func (modifiedFiles) SearchDisks(context.Context, string, int, int) (view.SearchResult, error) {
	return view.SearchResult{}, nil
}

func (m modifiedFiles) ModifiedFiles(context.Context, time.Time, time.Time, int) ([]view.Place, error) {
	place := view.Place{Display: `E:\Notes\plan.md`}
	place.Volume, place.Ref, place.Modified = "Data", "abababababababab", &m.at
	return []view.Place{place}, nil
}

func TestTimelineMergesMessagesActivityAndFiles(t *testing.T) {
	ctx := context.Background()
	c, s := libraryClient(t)
	activity := importWatch(t, s) // watched at 2026-08-14T09:12:33Z
	sent := time.Date(2026, 8, 14, 8, 0, 0, 0, time.UTC)
	if _, err := s.db.InsertMessages(ctx, []store.Message{
		{Source: "whatsapp", ExternalID: "in", Sender: "alice", Body: "lunch?", SentAt: sent},
		{Source: "whatsapp", ExternalID: "out", Sender: "alice", Body: "next week", SentAt: sent.AddDate(0, 0, 7)},
	}, store.InsertMessagesOpts{}); err != nil {
		t.Fatal(err)
	}
	day := time.Date(2026, 8, 14, 0, 0, 0, 0, time.Local)

	// Without a catalogue the archive still answers, and says what is missing.
	got, err := c.Timeline(ctx, day, day.AddDate(0, 0, 1), nil, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Events) != 2 || got.Events[0].Title != "lunch?" || !strings.HasPrefix(got.Events[0].Ref, "bank:") || got.Events[1].Ref != activity.ID {
		t.Fatalf("events = %+v", got.Events)
	}
	if !strings.Contains(strings.Join(got.Coverage, " "), "Files on disks are missing") {
		t.Fatalf("coverage = %v", got.Coverage)
	}

	s.UseCatalogue(modifiedFiles{at: sent.Add(30 * time.Minute)})
	got, err = c.Timeline(ctx, day, day.AddDate(0, 0, 1), nil, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Events) != 3 || got.Events[1].Ref != "attic:abababababababab" || got.Events[1].Source != "Data" {
		t.Fatalf("the file is not between the message and the watch: %+v", got.Events)
	}
	if only, err := c.Timeline(ctx, day, day.AddDate(0, 0, 1), []string{"activity"}, 1); err != nil || len(only.Events) != 1 || len(only.Truncated) != 0 {
		t.Fatalf("one group with exactly limit events: %+v, %v", only, err)
	}
	if only, err := c.Timeline(ctx, day, day.AddDate(0, 0, 8), []string{"message"}, 1); err != nil || len(only.Events) != 1 || len(only.Truncated) != 1 {
		t.Fatalf("one group past its limit: %+v, %v", only, err)
	}
}

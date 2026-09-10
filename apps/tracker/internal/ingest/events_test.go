package ingest

import (
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/aquitano/aqt/apps/tracker/internal/store"
)

func TestSpanStartNeedsExactlyOneIdentity(t *testing.T) {
	id, pv := uuid.Must(uuid.NewV7()).String(), uuid.Must(uuid.NewV7()).String()
	const at = "2026-09-08T10:00:00Z"
	ev, dropped := parseEvents([]wireEvent{
		{Type: store.EventSpanStart, ID: id, StartedAt: at, AppName: "Code",
			BundleID: "com.microsoft.VSCode", WindowTitle: strings.Repeat("t", maxTitleChars+10)},
		{Type: store.EventSpanStart, ID: uuid.Must(uuid.NewV7()).String(), StartedAt: at, PageViewID: pv, AppName: "Code"},
		{Type: store.EventSpanStart, ID: uuid.Must(uuid.NewV7()).String(), StartedAt: at},
	})
	if len(ev.SpanStarts) != 1 || dropped[store.EventSpanStart] != 2 {
		t.Fatalf("starts=%+v dropped=%d, want 1 start and 2 dropped", ev.SpanStarts, dropped[store.EventSpanStart])
	}
	desktop := ev.SpanStarts[0]
	if desktop.PageViewID != uuid.Nil || desktop.AppName != "Code" || desktop.BundleID != "com.microsoft.VSCode" {
		t.Errorf("desktop span = %+v", desktop)
	}
	if len(desktop.WindowTitle) != maxTitleChars {
		t.Errorf("window title kept %d characters, want %d", len(desktop.WindowTitle), maxTitleChars)
	}
}

func TestSpanEndReasons(t *testing.T) {
	const at = "2026-09-08T10:00:00Z"
	ev, _ := parseEvents([]wireEvent{
		{Type: store.EventSpanEnd, ID: uuid.Must(uuid.NewV7()).String(), EndedAt: at, Reason: "app_switch"},
		{Type: store.EventSpanEnd, ID: uuid.Must(uuid.NewV7()).String(), EndedAt: at, Reason: "abducted"},
	})
	if len(ev.SpanEnds) != 2 || ev.SpanEnds[0].Reason != "app_switch" || ev.SpanEnds[1].Reason != "unknown" {
		t.Fatalf("span ends = %+v", ev.SpanEnds)
	}
}

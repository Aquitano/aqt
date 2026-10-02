package agent

import (
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

const (
	typeSpanStart     = "span_start"
	typeSpanHeartbeat = "span_heartbeat"
	typeSpanEnd       = "span_end"

	maxTitleChars = 512
)

type EndReason string

const (
	EndAppSwitch    EndReason = "app_switch"
	EndWindowChange EndReason = "window_change"
	EndIdle         EndReason = "idle"
	EndPaused       EndReason = "paused"
	EndUnknown      EndReason = "unknown"
)

// Event is one entry of POST /v1/events/batch. It is flat like the server's
// union of event shapes, each type leaving the others' fields out.
type Event struct {
	Type        string    `json:"type"`
	ID          uuid.UUID `json:"id"`
	StartedAt   time.Time `json:"started_at,omitzero"`
	AppName     string    `json:"app_name,omitzero"`
	BundleID    string    `json:"bundle_id,omitzero"`
	WindowTitle string    `json:"window_title,omitzero"`
	At          time.Time `json:"at,omitzero"`
	EndedAt     time.Time `json:"ended_at,omitzero"`
	Reason      EndReason `json:"reason,omitzero"`
}

func spanStart(s Span) Event {
	return Event{Type: typeSpanStart, ID: s.ID, StartedAt: s.StartedAt.UTC(),
		AppName: s.App.Name, BundleID: s.App.ID, WindowTitle: s.Title}
}

func spanHeartbeat(id uuid.UUID, at time.Time) Event {
	return Event{Type: typeSpanHeartbeat, ID: id, At: at.UTC()}
}

func spanEnd(id uuid.UUID, at time.Time, reason EndReason) Event {
	return Event{Type: typeSpanEnd, ID: id, EndedAt: at.UTC(), Reason: reason}
}

// truncate cuts at the server's limit, in characters like the server does,
// so a title that only changes past it is not a new window.
func truncate(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	return string([]rune(s)[:max])
}

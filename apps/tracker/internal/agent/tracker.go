package agent

import (
	"time"

	"github.com/google/uuid"
)

// App is a desktop application as the server records it: ID is the bundle id,
// on Windows the lowercase exe name.
type App struct {
	Name string
	ID   string
}

type Window struct {
	App   App
	Class string
	Title string
}

type Span struct {
	ID        uuid.UUID
	App       App
	Title     string
	StartedAt time.Time
}

// Tracker is the whole span policy, free of Win32 and of the network: every
// input returns the events it causes. At most one span is open at a time.
type Tracker struct {
	lists   Lists
	focus   *App
	title   string
	idle    bool
	paused  bool
	ignored bool
	span    *Span
}

func NewTracker(lists Lists) *Tracker {
	return &Tracker{lists: lists}
}

func (t *Tracker) Open() (Span, bool) {
	if t.span == nil {
		return Span{}, false
	}
	return *t.span, true
}

// Focus reports the foreground window, after a switch or a title change alike.
// Titles seen while an ignored window is in front are its own, so they never
// reach the span left open underneath it.
func (t *Tracker) Focus(w Window, at time.Time) []Event {
	if t.ignored = t.lists.ignores(w); t.ignored {
		return nil
	}
	title := truncate(w.Title, maxTitleChars)
	if t.focus != nil && *t.focus == w.App {
		return t.retitle(title, at)
	}
	t.focus, t.title = &w.App, title
	return append(t.close(EndAppSwitch, at), t.start(at)...)
}

func (t *Tracker) retitle(title string, at time.Time) []Event {
	if title == t.title || t.lists.Private[t.focus.ID] {
		return nil
	}
	t.title = title
	if t.span == nil {
		return nil
	}
	return append(t.close(EndWindowChange, at), t.start(at)...)
}

// Idle ends the span at the last input, when attention stopped, not when the
// agent noticed.
func (t *Tracker) Idle(since time.Time) []Event {
	if t.idle {
		return nil
	}
	t.idle = true
	return t.close(EndIdle, since)
}

func (t *Tracker) Active(at time.Time) []Event {
	if !t.idle {
		return nil
	}
	t.idle = false
	return t.start(at)
}

func (t *Tracker) Pause(at time.Time) []Event {
	if t.paused {
		return nil
	}
	t.paused = true
	return t.close(EndPaused, at)
}

func (t *Tracker) Resume(at time.Time) []Event {
	if !t.paused {
		return nil
	}
	t.paused = false
	return t.start(at)
}

func (t *Tracker) Stop(at time.Time) []Event {
	return t.close(EndUnknown, at)
}

func (t *Tracker) Heartbeat(at time.Time) []Event {
	if t.span == nil {
		return nil
	}
	return []Event{spanHeartbeat(t.span.ID, at)}
}

func (t *Tracker) close(reason EndReason, at time.Time) []Event {
	if t.span == nil {
		return nil
	}
	s := t.span
	t.span = nil
	return []Event{spanEnd(s.ID, latest(s.StartedAt, at), reason)}
}

func (t *Tracker) start(at time.Time) []Event {
	if t.focus == nil || t.idle || t.paused || t.lists.Skip[t.focus.ID] {
		return nil
	}
	title := t.title
	if t.lists.Private[t.focus.ID] {
		title = ""
	}
	t.span = &Span{ID: uuid.Must(uuid.NewV7()), App: *t.focus, Title: title, StartedAt: at}
	return []Event{spanStart(*t.span)}
}

func latest(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

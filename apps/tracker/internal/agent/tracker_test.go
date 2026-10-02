package agent

import (
	"strings"
	"testing"
	"time"
)

var (
	t0       = time.Date(2026, 10, 2, 9, 0, 0, 0, time.UTC)
	editor   = App{Name: "Visual Studio Code", ID: "code.exe"}
	terminal = App{Name: "Windows Terminal", ID: "windowsterminal.exe"}
	chrome   = App{Name: "Google Chrome", ID: "chrome.exe"}
	vault    = App{Name: "1Password", ID: "1password.exe"}
	explorer = App{Name: "Windows Explorer", ID: "explorer.exe"}
)

func newTracker(t *testing.T) *Tracker {
	t.Helper()
	c, err := ConfigFromEnv(func(name string) (string, bool) { return "", name == "TRACKER_TOKEN_PATH" })
	if err != nil {
		t.Fatal(err)
	}
	return NewTracker(c.Lists)
}

func TestAnAppSwitchEndsTheSpanAndStartsOneForTheNewApp(t *testing.T) {
	tr := newTracker(t)
	first := tr.Focus(Window{App: editor, Title: "main.go"}, t0)

	events := tr.Focus(Window{App: terminal, Title: "pwsh"}, t0.Add(time.Minute))

	if len(events) != 2 || events[0].Type != typeSpanEnd || events[0].ID != first[0].ID || events[0].Reason != EndAppSwitch {
		t.Fatalf("events = %+v, want the editor's span ended by an app switch", events)
	}
	if s := events[1]; s.Type != typeSpanStart || s.AppName != "Windows Terminal" || s.BundleID != "windowsterminal.exe" || s.WindowTitle != "pwsh" {
		t.Errorf("start = %+v", s)
	}
}

func TestATitleChangeRestartsTheSpanWithTheNewTitle(t *testing.T) {
	tr := newTracker(t)
	tr.Focus(Window{App: editor, Title: "main.go"}, t0)

	events := tr.Focus(Window{App: editor, Title: "server.go"}, t0)

	if len(events) != 2 || events[0].Reason != EndWindowChange || events[1].WindowTitle != "server.go" {
		t.Fatalf("events = %+v, want a window change into server.go", events)
	}
	if again := tr.Focus(Window{App: editor, Title: "server.go"}, t0); len(again) != 0 {
		t.Errorf("the same window reported again produced %+v", again)
	}
}

func TestATitleThatOnlyChangesPastTheServersLimitIsTheSameWindow(t *testing.T) {
	long := strings.Repeat("é", maxTitleChars)
	tr := newTracker(t)

	start := tr.Focus(Window{App: editor, Title: long + "1"}, t0)

	if start[0].WindowTitle != long {
		t.Errorf("title kept %d characters, want %d", len([]rune(start[0].WindowTitle)), maxTitleChars)
	}
	if events := tr.Focus(Window{App: editor, Title: long + "2"}, t0); len(events) != 0 {
		t.Errorf("events = %+v, want none", events)
	}
}

func TestIdleEndsTheSpanAtTheLastInputButNeverBeforeItStarted(t *testing.T) {
	tr := newTracker(t)
	tr.Focus(Window{App: editor, Title: "main.go"}, t0)

	idle := tr.Idle(t0.Add(5 * time.Second))
	if len(idle) != 1 || idle[0].Reason != EndIdle || !idle[0].EndedAt.Equal(t0.Add(5*time.Second)) {
		t.Fatalf("idle = %+v, want an end at the last input", idle)
	}
	if events := tr.Focus(Window{App: terminal, Title: "pwsh"}, t0.Add(70*time.Second)); len(events) != 0 {
		t.Errorf("a switch while idle produced %+v", events)
	}

	resumed := tr.Active(t0.Add(100 * time.Second))
	if len(resumed) != 1 || resumed[0].BundleID != terminal.ID {
		t.Fatalf("resumed = %+v, want a span for the terminal", resumed)
	}
	again := tr.Idle(t0.Add(90 * time.Second))
	if !again[0].EndedAt.Equal(t0.Add(100 * time.Second)) {
		t.Errorf("ended at %v, before the span started", again[0].EndedAt)
	}
}

func TestAnIgnoredWindowLeavesTheSpanUnderneathOpenWithItsTitle(t *testing.T) {
	tr := newTracker(t)
	tr.Focus(Window{App: editor, Title: "main.go"}, t0)

	for _, overlay := range []Window{
		{App: App{Name: "Search", ID: "searchhost.exe"}, Title: "Search"},
		{App: explorer, Class: "Shell_TrayWnd", Title: "Taskbar"},
		{App: explorer, Class: "Shell_TrayWnd", Title: "Taskbar, 3 notifications"},
	} {
		if events := tr.Focus(overlay, t0); len(events) != 0 {
			t.Errorf("%s %s: events = %+v", overlay.App.ID, overlay.Class, events)
		}
	}
	if events := tr.Focus(Window{App: editor, Title: "main.go"}, t0); len(events) != 0 {
		t.Errorf("returning to the editor produced %+v", events)
	}
	if span, _ := tr.Open(); span.App != editor || span.Title != "main.go" {
		t.Errorf("open span = %+v", span)
	}
	if events := tr.Focus(Window{App: explorer, Class: "CabinetWClass", Title: "Downloads"}, t0); len(events) != 2 {
		t.Errorf("a File Explorer window produced %+v, want a switch to it", events)
	}
}

func TestASkippedBrowserOpensNoSpan(t *testing.T) {
	tr := newTracker(t)
	tr.Focus(Window{App: editor, Title: "main.go"}, t0)

	events := tr.Focus(Window{App: chrome, Title: "Hacker News"}, t0)

	if len(events) != 1 || events[0].Reason != EndAppSwitch {
		t.Fatalf("events = %+v, want only the editor's span ended", events)
	}
	if _, open := tr.Open(); open {
		t.Error("a span is open while the browser is in front")
	}
}

func TestAPrivateAppGetsASpanWithoutATitle(t *testing.T) {
	tr := newTracker(t)

	events := tr.Focus(Window{App: vault, Title: "AWS root"}, t0)

	if len(events) != 1 || events[0].AppName != "1Password" || events[0].WindowTitle != "" {
		t.Fatalf("events = %+v, want a span with no title", events)
	}
	if events := tr.Focus(Window{App: vault, Title: "Bank"}, t0); len(events) != 0 {
		t.Errorf("a private title change produced %+v", events)
	}
}

func TestPauseEndsTheSpanAndResumeStartsOneForWhatIsInFront(t *testing.T) {
	tr := newTracker(t)
	tr.Focus(Window{App: editor, Title: "main.go"}, t0)

	paused := tr.Pause(t0.Add(time.Minute))
	if len(paused) != 1 || paused[0].Reason != EndPaused {
		t.Fatalf("paused = %+v, want the span ended as paused", paused)
	}
	if events := append(tr.Focus(Window{App: terminal, Title: "pwsh"}, t0.Add(2*time.Minute)),
		tr.Heartbeat(t0.Add(3*time.Minute))...); len(events) != 0 {
		t.Errorf("events while paused: %+v", events)
	}

	resumed := tr.Resume(t0.Add(time.Hour))
	if len(resumed) != 1 || resumed[0].BundleID != terminal.ID || !resumed[0].StartedAt.Equal(t0.Add(time.Hour)) {
		t.Errorf("resumed = %+v, want the terminal from the resume on", resumed)
	}
}

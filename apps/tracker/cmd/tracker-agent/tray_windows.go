package main

import (
	_ "embed"
	"fmt"

	"fyne.io/systray"

	"github.com/aquitano/aqt/apps/tracker/internal/agent"
)

var (
	//go:embed tracker.ico
	iconHealthy []byte
	//go:embed tracker-warning.ico
	iconWarning []byte
)

const (
	menuTextLimit = 60
	pauseText     = "Pause for 1 hour"
)

// line is a disabled menu item that only shows text. fyne's SetTitle puts a
// hidden item back and Hide on a hidden one fails, so the line remembers
// what it shows and touches the menu only when that changes.
type line struct {
	item  *systray.MenuItem
	text  string
	shown bool
}

func newLine() *line {
	item := systray.AddMenuItem("", "")
	item.Disable()
	return &line{item: item, shown: true}
}

func (l *line) set(text string) {
	switch {
	case text == "" && l.shown:
		l.item.Hide()
		l.shown = false
	case text != "" && (text != l.text || !l.shown):
		l.item.SetTitle(text)
		l.shown = true
	}
	l.text = text
}

// runTray owns the notification area icon until Quit. It runs on systray's
// ready goroutine and renders whenever the agent or the syncer changes.
func runTray(tracker *agent.Agent, syncer *agent.Syncer, commands chan<- agent.Command, changed <-chan struct{}) {
	systray.SetIcon(iconHealthy)
	systray.SetTooltip("tracker agent")
	server, tracking, queue, failure := newLine(), newLine(), newLine(), newLine()
	systray.AddSeparator()
	pause := systray.AddMenuItem(pauseText, "")
	quit := systray.AddMenuItem("Quit", "")

	healthy, paused := true, false
	render := func() {
		st, sync := tracker.Status(), syncer.Status()
		server.set(serverText(sync))
		tracking.set(trackingText(st))
		queue.set(queueText(sync))
		failure.set(errorText(sync))
		if now := !st.PausedUntil.IsZero(); now != paused {
			paused = now
			title := pauseText
			if paused {
				title = "Resume"
			}
			pause.SetTitle(title)
		}
		if now := !sync.Contacted || (sync.Reachable && sync.Error == ""); now != healthy {
			healthy = now
			icon := iconWarning
			if healthy {
				icon = iconHealthy
			}
			systray.SetIcon(icon)
		}
	}
	render()
	for {
		select {
		case <-changed:
			render()
		case <-pause.ClickedCh:
			if paused {
				commands <- agent.Resume
			} else {
				commands <- agent.Pause
			}
		case <-quit.ClickedCh:
			systray.Quit()
			return
		}
	}
}

func serverText(s agent.SyncStatus) string {
	switch {
	case !s.Contacted:
		return "Server: not contacted yet"
	case s.Reachable:
		return "Server: connected"
	default:
		return "Server: unreachable"
	}
}

func trackingText(s agent.Status) string {
	switch {
	case !s.PausedUntil.IsZero():
		return "Paused until " + s.PausedUntil.Format("15:04")
	case !s.Tracking:
		return "Tracking: nothing"
	case s.Span.Title == "":
		return "Tracking: " + s.Span.App.Name
	default:
		return clip("Tracking: " + s.Span.App.Name + " — " + s.Span.Title)
	}
}

func queueText(s agent.SyncStatus) string {
	if s.Dropped == 0 {
		return fmt.Sprintf("Queued: %d", s.Pending)
	}
	return fmt.Sprintf("Queued: %d, dropped %d", s.Pending, s.Dropped)
}

func errorText(s agent.SyncStatus) string {
	if s.Error == "" {
		return ""
	}
	return clip("Last error: " + s.Error)
}

func clip(s string) string {
	if r := []rune(s); len(r) > menuTextLimit {
		return string(r[:menuTextLimit-1]) + "…"
	}
	return s
}

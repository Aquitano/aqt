// Package agent is the desktop agent without its desktop: the span policy, the
// outbox and the sync loop, driven by a Desktop that reports the foreground
// window and the last input. cmd/tracker-agent supplies the Windows one.
package agent

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

const (
	heartbeatInterval = 30 * time.Second
	idlePollInterval  = 5 * time.Second
	idleThreshold     = 60 * time.Second
	titleDebounce     = time.Second
	pauseLength       = time.Hour
)

type Desktop interface {
	Foreground() (Window, bool)
	LastInput() time.Time
}

// Signal is something the desktop noticed. Focus and title changes carry no
// window: the agent reads the foreground itself, so a burst of signals costs
// one read.
type Signal int

const (
	FocusChanged Signal = iota + 1
	TitleChanged
	Locked
	Unlocked
	Suspended
	Resumed
)

type Command int

const (
	Pause Command = iota + 1
	Resume
)

type Status struct {
	Span        Span
	Tracking    bool
	PausedUntil time.Time
}

type Agent struct {
	desktop Desktop
	tracker *Tracker
	sync    *Syncer
	log     *slog.Logger
	changed func()

	idle, inputIdle, locked, asleep bool
	lastInput                       time.Time
	pausedUntil                     time.Time

	mu     sync.Mutex
	status Status
}

func New(desktop Desktop, lists Lists, s *Syncer, log *slog.Logger, changed func()) *Agent {
	return &Agent{desktop: desktop, tracker: NewTracker(lists), sync: s, log: log, changed: changed}
}

func (a *Agent) Status() Status {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.status
}

// Run tracks until ctx ends, then ends the open span as unknown.
func (a *Agent) Run(ctx context.Context, signals <-chan Signal, commands <-chan Command) {
	heartbeat := time.NewTicker(heartbeatInterval)
	defer heartbeat.Stop()
	inputCheck := time.NewTimer(0)
	defer inputCheck.Stop()
	// A retitled tab or a title bar that counts down renames the window per
	// keystroke or per second; one span each is not attention data.
	retitled := time.NewTimer(titleDebounce)
	retitled.Stop()
	pauseOver := time.NewTimer(pauseLength)
	pauseOver.Stop()

	a.refocus(time.Now())
	a.publish()
	for {
		select {
		case <-ctx.Done():
			a.emit(a.tracker.Stop(time.Now()))
			return
		case s := <-signals:
			if s == TitleChanged {
				retitled.Reset(titleDebounce)
				continue
			}
			a.handle(s, time.Now())
			if s != FocusChanged {
				a.recheck(inputCheck, idlePollInterval)
			}
		case now := <-retitled.C:
			a.refocus(now)
		case now := <-heartbeat.C:
			a.emit(a.tracker.Heartbeat(now))
		case now := <-inputCheck.C:
			// By the wall clock: a monotonic clock may stop while the machine
			// sleeps, and the last input's age keeps counting.
			a.lastInput = a.desktop.LastInput().Round(0)
			age := now.Sub(a.lastInput)
			a.inputIdle = age >= idleThreshold
			a.settle(now)
			next := idlePollInterval
			if !a.inputIdle {
				next = idleThreshold - age
			}
			a.recheck(inputCheck, next)
		case c := <-commands:
			now := time.Now()
			switch c {
			case Pause:
				pauseOver.Reset(pauseLength)
				a.pausedUntil = now.Add(pauseLength)
				a.emit(a.tracker.Pause(now))
			case Resume:
				pauseOver.Stop()
				a.resume(now)
			}
		case now := <-pauseOver.C:
			a.resume(now)
		}
		a.publish()
	}
}

// handle keeps each reason to be idle apart: a machine locked before it slept
// stays idle after waking until it is unlocked. Unlocking and waking take
// input the poll has not seen yet, so a stale last input must not undo them.
func (a *Agent) handle(s Signal, now time.Time) {
	switch s {
	case FocusChanged:
		a.refocus(now)
		return
	case Locked:
		a.locked = true
	case Unlocked:
		a.locked, a.inputIdle = false, false
	case Suspended:
		a.asleep = true
	case Resumed:
		a.asleep, a.inputIdle = false, false
	}
	a.settle(now)
}

// recheck schedules the next read of the last input. Recent input cannot
// cross the threshold before it has been quiet that long; once idle, only a
// poll notices input resuming. Locked or asleep is idle whatever the counter
// says, so it is not read until the machine is back.
func (a *Agent) recheck(timer *time.Timer, after time.Duration) {
	if a.locked || a.asleep {
		timer.Stop()
		return
	}
	timer.Reset(after)
}

func (a *Agent) settle(now time.Time) {
	idle := a.inputIdle || a.locked || a.asleep
	if idle == a.idle {
		return
	}
	a.idle = idle
	if !idle {
		a.refocus(now)
		a.emit(a.tracker.Active(now))
		return
	}
	since := now
	if a.inputIdle {
		since = a.lastInput
	}
	a.emit(a.tracker.Idle(since))
}

func (a *Agent) resume(now time.Time) {
	a.pausedUntil = time.Time{}
	a.refocus(now)
	a.emit(a.tracker.Resume(now))
}

func (a *Agent) refocus(now time.Time) {
	if w, ok := a.desktop.Foreground(); ok {
		a.emit(a.tracker.Focus(w, now))
	}
}

func (a *Agent) emit(events []Event) {
	if len(events) == 0 {
		return
	}
	for _, e := range events {
		a.log.Debug(e.Type, "app", e.BundleID, "reason", e.Reason)
	}
	a.sync.Enqueue(events)
}

func (a *Agent) publish() {
	span, open := a.tracker.Open()
	a.mu.Lock()
	a.status = Status{Span: span, Tracking: open, PausedUntil: a.pausedUntil}
	a.mu.Unlock()
	a.changed()
}

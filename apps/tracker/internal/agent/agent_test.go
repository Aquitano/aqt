package agent

import (
	"context"
	"log/slog"
	"path/filepath"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/google/uuid"
)

type fakeDesktop struct {
	mu        sync.Mutex
	lastInput time.Time
	reads     int
}

func (d *fakeDesktop) Foreground() (Window, bool) {
	return Window{App: editor, Title: "main.go"}, true
}

func (d *fakeDesktop) LastInput() time.Time {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.reads++
	return d.lastInput
}

func (d *fakeDesktop) input() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.lastInput = time.Now()
}

func (d *fakeDesktop) inputReads() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.reads
}

// runAgent runs an agent over desk inside the current synctest bubble until
// the test ends, and returns its outbox.
func runAgent(t *testing.T, desk Desktop, signals <-chan Signal) *Outbox {
	t.Helper()
	outbox, _, err := OpenOutbox(filepath.Join(t.TempDir(), "device.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewSyncer(Config{ServerURL: "http://127.0.0.1:1"}, uuid.Must(uuid.NewV7()), outbox, slog.New(slog.DiscardHandler), func() {})
	if err != nil {
		t.Fatal(err)
	}
	a := New(desk, Lists{}, s, slog.New(slog.DiscardHandler), func() {})
	ctx, stop := context.WithCancel(context.Background())
	go a.Run(ctx, signals, nil)
	t.Cleanup(func() {
		stop()
		synctest.Wait()
	})
	synctest.Wait()
	return outbox
}

func ends(o *Outbox) []Event {
	events, _ := o.Peek(outboxCapacity)
	var ends []Event
	for _, e := range events {
		if e.Type == typeSpanEnd {
			ends = append(ends, e)
		}
	}
	return ends
}

func TestIdleIsCheckedWhenTheLastInputCanFirstBeAMinuteOld(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		desk := &fakeDesktop{}
		desk.input()
		start := time.Now()
		outbox := runAgent(t, desk, nil)

		time.Sleep(40 * time.Second)
		desk.input()
		time.Sleep(59 * time.Second)
		synctest.Wait()
		if got := ends(outbox); len(got) != 0 {
			t.Fatalf("ended %+v while the last input was under a minute old", got)
		}

		time.Sleep(time.Second)
		synctest.Wait()
		got := ends(outbox)
		if len(got) != 1 || got[0].Reason != EndIdle || !got[0].EndedAt.Equal(start.Add(40*time.Second)) {
			t.Fatalf("ends = %+v, want one idle end at the last input", got)
		}
		if reads := desk.inputReads(); reads != 3 {
			t.Errorf("read the last input %d times in 100 s, want 3: at start, at 60 s, at 100 s", reads)
		}

		time.Sleep(2 * time.Second)
		desk.input()
		time.Sleep(3 * time.Second)
		synctest.Wait()
		events, _ := outbox.Peek(outboxCapacity)
		if last := events[len(events)-1]; last.Type != typeSpanStart || !last.StartedAt.Equal(start.Add(105*time.Second)) {
			t.Errorf("last event %+v, want a span opened by the first poll after input resumed", last)
		}
	})
}

func TestNothingIsCheckedWhileLocked(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		desk := &fakeDesktop{}
		desk.input()
		start := time.Now()
		signals := make(chan Signal)
		outbox := runAgent(t, desk, signals)

		time.Sleep(30 * time.Second)
		signals <- Locked
		time.Sleep(time.Hour)
		synctest.Wait()
		if got := ends(outbox); len(got) != 1 || !got[0].EndedAt.Equal(start.Add(30*time.Second)) {
			t.Fatalf("ends = %+v, want one idle end at the lock", got)
		}
		if reads := desk.inputReads(); reads != 1 {
			t.Errorf("read the last input %d times while locked for an hour, want only the first", reads)
		}

		desk.input()
		signals <- Unlocked
		time.Sleep(idlePollInterval)
		synctest.Wait()
		if reads := desk.inputReads(); reads != 2 {
			t.Errorf("read the last input %d times, want once more a poll after the unlock", reads)
		}
	})
}

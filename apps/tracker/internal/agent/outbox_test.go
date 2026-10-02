package agent

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
)

func heartbeats(n int) []Event {
	id := uuid.Must(uuid.NewV7())
	events := make([]Event, n)
	for i := range events {
		events[i] = spanHeartbeat(id, t0.Add(time.Duration(i)*time.Second))
	}
	return events
}

func lineCount(t *testing.T, path string) int {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return bytes.Count(raw, []byte("\n"))
}

func reopen(t *testing.T, path string, capacity int) *Outbox {
	t.Helper()
	o, aside, err := openOutbox(path, capacity)
	if err != nil || aside != "" {
		t.Fatalf("reopen: aside %q, err %v", aside, err)
	}
	return o
}

func TestOutboxAppendsAndCompactsOnlyWhenABatchIsAcknowledged(t *testing.T) {
	path := filepath.Join(t.TempDir(), "outbox", "device.jsonl")
	o := reopen(t, path, outboxCapacity)
	span := Span{ID: uuid.Must(uuid.NewV7()), App: editor, Title: "main.go", StartedAt: t0}
	events := []Event{spanStart(span), spanHeartbeat(span.ID, t0.Add(30*time.Second)), spanEnd(span.ID, t0.Add(time.Minute), EndIdle)}

	o.Append(events[:1])
	o.Append(events[1:])
	if n := lineCount(t, path); n != 3 {
		t.Fatalf("file holds %d lines after two appends, want 3", n)
	}
	if got, _ := reopen(t, path, outboxCapacity).Peek(10); !reflect.DeepEqual(got, events) {
		t.Fatalf("restored %+v, want %+v", got, events)
	}

	_, mark := o.Peek(2)
	o.Ack(mark)
	if got, _ := reopen(t, path, outboxCapacity).Peek(10); !reflect.DeepEqual(got, events[2:]) {
		t.Errorf("after the ack the file holds %+v, want only the end", got)
	}
}

func TestOutboxDropsTheOldestPastTheCap(t *testing.T) {
	path := filepath.Join(t.TempDir(), "device.jsonl")
	events := heartbeats(6)
	o := reopen(t, path, 3)
	o.Append(events[:2])
	inFlight, mark := o.Peek(2)

	for _, e := range events[2:] {
		o.Append([]Event{e})
	}
	if pending, dropped, _ := o.Status(); pending != 3 || dropped != 3 {
		t.Fatalf("pending %d dropped %d, want 3 and 3", pending, dropped)
	}
	o.Ack(mark)

	if got, _ := o.Peek(10); !reflect.DeepEqual(got, events[3:]) {
		t.Errorf("queue %+v, want the newest three: acking %d events dropped in flight removed newer ones", got, len(inFlight))
	}
	if got, _ := reopen(t, path, 3).Peek(10); !reflect.DeepEqual(got, events[3:]) {
		t.Errorf("restored %+v, want the newest three", got)
	}
}

func TestOutboxMovesAnUnreadableFileAsideAndStartsEmpty(t *testing.T) {
	path := filepath.Join(t.TempDir(), "device.jsonl")
	corrupt := []byte("{\"type\":\"span_heartbeat\"}\nnot json\n")
	if err := os.WriteFile(path, corrupt, 0o600); err != nil {
		t.Fatal(err)
	}

	o, aside, err := openOutbox(path, outboxCapacity)
	if err != nil {
		t.Fatal(err)
	}

	if kept, err := os.ReadFile(aside); err != nil || !bytes.Equal(kept, corrupt) {
		t.Fatalf("aside %q holds %q (%v), want the unreadable file untouched", aside, kept, err)
	}
	if pending, _, _ := o.Status(); pending != 0 {
		t.Errorf("pending %d, want an empty queue", pending)
	}
	o.Append(heartbeats(1))
	if n := lineCount(t, path); n != 1 {
		t.Errorf("fresh file holds %d lines, want 1", n)
	}
}

func TestOutboxLosesOnlyTheAppendACrashCutShort(t *testing.T) {
	path := filepath.Join(t.TempDir(), "device.jsonl")
	o := reopen(t, path, outboxCapacity)
	events := heartbeats(2)
	o.Append(events)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw[:len(raw)-5], 0o600); err != nil {
		t.Fatal(err)
	}

	if got, _ := reopen(t, path, outboxCapacity).Peek(10); !reflect.DeepEqual(got, events[:1]) {
		t.Errorf("restored %+v, want the first event", got)
	}
	if n := lineCount(t, path); n != 1 {
		t.Errorf("file holds %d lines, want the torn one gone", n)
	}
}

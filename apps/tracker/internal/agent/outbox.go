package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

const outboxCapacity = 10_000

// Outbox is the queue of events the server has not acknowledged, kept as a
// JSON-lines file so that an enqueue is one small append. The file is only
// rewritten to compact it: after a batch is acknowledged, and once the events
// dropped for the cap fill a whole capacity's worth of lines at its start.
// Those lines need no rewrite before then, since the queue is always the
// file's last lines.
type Outbox struct {
	mu       sync.Mutex
	path     string
	capacity int
	events   []Event
	head     uint64
	stale    int
	rewrite  bool
	dropped  int
	err      error
}

// OpenOutbox restores the queue at path. A file it cannot parse is moved
// aside, never overwritten, and the queue starts empty; aside says where the
// file went.
func OpenOutbox(path string) (o *Outbox, aside string, err error) {
	return openOutbox(path, outboxCapacity)
}

func openOutbox(path string, capacity int) (*Outbox, string, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, "", err
	}
	o := &Outbox{path: path, capacity: capacity}
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return o, "", nil
	}
	if err != nil {
		return nil, "", err
	}
	events, torn, err := decodeLines(raw)
	if err != nil {
		aside := fmt.Sprintf("%s.unreadable-%d", path, time.Now().UnixNano())
		if err := os.Rename(path, aside); err != nil {
			return nil, "", err
		}
		return o, aside, nil
	}
	over := max(len(events)-capacity, 0)
	o.events = events[over:]
	if torn || over > 0 {
		o.compact()
	}
	return o, "", nil
}

// decodeLines reads one event per line. Text after the last newline is an
// append a crash cut short: it costs that event, not the queue.
func decodeLines(raw []byte) (events []Event, torn bool, err error) {
	lines := bytes.Split(raw, []byte("\n"))
	for _, line := range lines[:len(lines)-1] {
		var e Event
		if err := json.Unmarshal(line, &e); err != nil {
			return nil, false, err
		}
		events = append(events, e)
	}
	return events, len(lines[len(lines)-1]) > 0, nil
}

// Append queues events, dropping the oldest past the cap, and returns how many
// are pending.
func (o *Outbox) Append(events []Event) int {
	o.mu.Lock()
	defer o.mu.Unlock()
	lines, err := encodeLines(events)
	if err != nil {
		o.err = err
		return len(o.events)
	}
	o.events = append(o.events, events...)
	if over := len(o.events) - o.capacity; over > 0 {
		o.events = o.events[over:]
		o.head += uint64(over)
		o.stale += over
		o.dropped += over
	}
	if o.rewrite || o.stale >= o.capacity {
		o.compact()
		return len(o.events)
	}
	o.err = appendFile(o.path, lines)
	o.rewrite = o.err != nil
	return len(o.events)
}

// Peek returns up to n of the oldest events and the mark that acknowledges
// them.
func (o *Outbox) Peek(n int) ([]Event, uint64) {
	o.mu.Lock()
	defer o.mu.Unlock()
	n = min(n, len(o.events))
	return slices.Clone(o.events[:n]), o.head + uint64(n)
}

// Ack removes the events up to mark. The mark counts from the start of the
// queue's history, not of the batch, so events dropped for the cap while the
// batch was in flight are not removed a second time.
func (o *Outbox) Ack(mark uint64) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if mark <= o.head {
		return
	}
	n := min(int(mark-o.head), len(o.events))
	o.events = o.events[n:]
	o.head += uint64(n)
	o.compact()
}

func (o *Outbox) Status() (pending, dropped int, err error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.events), o.dropped, o.err
}

func (o *Outbox) compact() {
	lines, err := encodeLines(o.events)
	if err == nil {
		err = replaceFile(o.path, lines)
	}
	o.err, o.rewrite = err, err != nil
	if err == nil {
		o.stale = 0
	}
}

func encodeLines(events []Event) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	for _, e := range events {
		if err := enc.Encode(e); err != nil {
			return nil, err
		}
	}
	return buf.Bytes(), nil
}

func appendFile(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// replaceFile writes and renames, so a crash leaves the old queue or the new
// one, never half of either.
func replaceFile(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".outbox-*.jsonl")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

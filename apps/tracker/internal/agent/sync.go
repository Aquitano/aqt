package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/aquitano/aqt/apps/tracker/internal/client"
)

const (
	flushInterval  = 10 * time.Second
	flushThreshold = 100
	maxBatch       = 1000
	maxBackoff     = 5 * time.Minute
	requestTimeout = 15 * time.Second
)

// Syncer delivers the outbox to POST /v1/events/batch: every 10 s or at 100
// pending, backing off to 5 minutes while the server cannot take a batch.
type Syncer struct {
	url       string
	deviceID  uuid.UUID
	outbox    *Outbox
	tokenPath string
	http      *http.Client
	log       *slog.Logger
	now       func() time.Time
	changed   func()
	kick      chan struct{}

	mu       sync.Mutex
	failures int
	retryAt  time.Time
	dropped  int
	status   SyncStatus
}

type SyncStatus struct {
	Contacted bool
	Reachable bool
	Pending   int
	Dropped   int
	Error     string
}

func NewSyncer(c Config, deviceID uuid.UUID, outbox *Outbox, log *slog.Logger, changed func()) (*Syncer, error) {
	endpoint, err := url.JoinPath(c.ServerURL, "v1/events/batch")
	if err != nil {
		return nil, fmt.Errorf("TRACKER_SERVER_URL: %w", err)
	}
	return &Syncer{
		url: endpoint, deviceID: deviceID, outbox: outbox, tokenPath: c.TokenPath,
		http: &http.Client{Timeout: requestTimeout}, log: log, now: time.Now, changed: changed,
		kick: make(chan struct{}, 1),
	}, nil
}

func (s *Syncer) Enqueue(events []Event) {
	if s.outbox.Append(events) >= flushThreshold {
		select {
		case s.kick <- struct{}{}:
		default:
		}
	}
	s.changed()
}

func (s *Syncer) Run(ctx context.Context) {
	tick := time.NewTicker(flushInterval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		case <-s.kick:
		}
		s.flushIfDue(ctx)
	}
}

func (s *Syncer) flushIfDue(ctx context.Context) {
	s.mu.Lock()
	due := !s.now().Before(s.retryAt)
	s.mu.Unlock()
	if due {
		s.Flush(ctx)
	}
}

// Flush sends batches until the outbox is empty or the server cannot take one.
func (s *Syncer) Flush(ctx context.Context) {
	for {
		batch, mark := s.outbox.Peek(maxBatch)
		if len(batch) == 0 || !s.deliver(ctx, batch, mark) {
			return
		}
	}
}

func (s *Syncer) deliver(ctx context.Context, batch []Event, mark uint64) bool {
	status, dropped, err := s.post(ctx, batch)
	defer s.changed()
	if err == nil || permanent(status) {
		s.outbox.Ack(mark)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status.Contacted = true
	s.status.Reachable = status >= 200 && status < 500
	switch {
	case err == nil:
		s.failures, s.retryAt, s.dropped = 0, time.Time{}, s.dropped+dropped
		s.status.Error = ""
		return true
	case permanent(status):
		s.dropped += len(batch)
		s.status.Error = err.Error()
		s.log.Error("server rejected a batch, dropped it", "events", len(batch), "err", err)
		return true
	default:
		s.failures++
		wait := backoff(s.failures)
		s.retryAt = s.now().Add(wait)
		s.status.Error = err.Error()
		s.log.Warn("sync failed", "retry_in", wait, "err", err)
		return false
	}
}

func (s *Syncer) post(ctx context.Context, events []Event) (status, dropped int, err error) {
	body, err := json.Marshal(struct {
		DeviceID uuid.UUID `json:"device_id"`
		Events   []Event   `json:"events"`
	}{s.deviceID, events})
	if err != nil {
		return 0, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url, bytes.NewReader(body))
	if err != nil {
		return 0, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	token, err := s.bearer(ctx)
	if err != nil {
		return 0, 0, fmt.Errorf("token: %w", err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := s.http.Do(req)
	if err != nil {
		return 0, 0, err
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode == http.StatusUnauthorized:
		return res.StatusCode, 0, errors.New("HTTP 401: run 'tracker login'")
	case res.StatusCode < 200 || res.StatusCode >= 300:
		return res.StatusCode, 0, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	var receipt struct {
		Dropped int `json:"dropped"`
	}
	if err := json.NewDecoder(res.Body).Decode(&receipt); err != nil {
		s.log.Warn("unreadable receipt for an accepted batch", "err", err)
	}
	return res.StatusCode, receipt.Dropped, nil
}

// bearer is empty when there is nothing to present, which is right against a
// server with no issuer configured.
func (s *Syncer) bearer(ctx context.Context) (string, error) {
	if s.tokenPath == "" {
		return "", nil
	}
	token, err := client.Bearer(ctx, s.tokenPath)
	if errors.Is(err, client.ErrSignedOut) {
		return "", nil
	}
	return token, err
}

func (s *Syncer) Status() SyncStatus {
	pending, overflowed, storeErr := s.outbox.Status()
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.status
	st.Pending, st.Dropped = pending, overflowed+s.dropped
	if storeErr != nil {
		st.Error = "outbox: " + storeErr.Error()
	}
	return st
}

// permanent is a batch that will never be accepted as written. 401 and 403
// are fixed by signing in, 408 and 429 by waiting.
func permanent(status int) bool {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusRequestTimeout, http.StatusTooManyRequests:
		return false
	}
	return status >= 400 && status < 500
}

func backoff(failures int) time.Duration {
	return min(time.Second<<min(failures, 16), maxBackoff)
}

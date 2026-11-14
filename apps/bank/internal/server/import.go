package server

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/blobtext"
	"github.com/aquitano/aqt/packages/go/extract"
)

// extractAfterImport reads text out of newly stored attachments so an upload
// becomes searchable inside its documents shortly after it lands. Newest first
// and limited to content stored since the upload arrived: the batch has to
// reach what this upload stored even when a large backlog is waiting, and it
// must not turn one upload into a whole-archive pass. The older backlog is the
// nightly `bank extract`'s.
//
// Only the cheap pure-Go extractors ever run here. OCR needs tesseract and
// poppler, which are deliberately not in this image — the process listening on
// a port holds one static binary and no shell — so scanned documents are
// recorded as needing OCR and read later by `bank extract --ocr`, which can
// run anywhere, including a laptop against this server.
//
// Never fatal: the message and its blobs are already archived, and text is
// derived data that any later pass can rebuild.
//
// It runs after the response, in the background: a client that times out
// waiting for extraction retries an import that already committed. One run is
// in flight at a time; uploads arriving meanwhile request a single rerun, so a
// backfill does not queue a pass per message, and a full batch runs again until
// everything stored since the first of those uploads arrived is drained.
func (s *Server) extractAfterImport(received time.Time) {
	if os.Getenv("BANK_EXTRACT") == "off" {
		return
	}
	s.extraction.mu.Lock()
	defer s.extraction.mu.Unlock()
	if s.extraction.stopping {
		return
	}
	if !s.extraction.running || received.Before(s.extraction.since) {
		s.extraction.since = received
	}
	if s.extraction.arrived.IsZero() || received.Before(s.extraction.arrived) {
		s.extraction.arrived = received
	}
	if s.extraction.running {
		s.extraction.again = true
		return
	}
	s.extraction.running = true
	s.extraction.done.Go(s.extractUntilCurrent)
}

type extraction struct {
	ctx      context.Context
	stopping bool
	mu       sync.Mutex
	running  bool
	again    bool
	since    time.Time
	arrived  time.Time
	done     sync.WaitGroup
}

// extractUntilCurrent refreshes, after each pass, only what changed since the
// previous pass started, which is earlier than that pass's own refresh and so
// leaves no gap. An upload commits before it schedules extraction, so one that
// committed after a refresh is covered by starting the next window no later
// than its arrival.
func (s *Server) extractUntilCurrent() {
	ctx := s.extraction.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	var refreshSince time.Time
	for {
		s.extraction.mu.Lock()
		since := s.extraction.since
		if arrived := s.extraction.arrived; !arrived.IsZero() && (refreshSince.IsZero() || arrived.Before(refreshSince)) {
			refreshSince = arrived
		}
		s.extraction.arrived = time.Time{}
		s.extraction.mu.Unlock()
		started := time.Now()
		backlog := s.extractPending(ctx, since, refreshSince)
		refreshSince = started
		s.extraction.mu.Lock()
		again := !s.extraction.stopping && (backlog || s.extraction.again)
		s.extraction.again = false
		s.extraction.running = again
		s.extraction.mu.Unlock()
		if !again {
			return
		}
	}
}

func (s *Server) extractPending(ctx context.Context, since, refreshSince time.Time) (backlog bool) {
	o := extract.DefaultOptions()
	o.TempDir = tempDir(s.dataDir)
	sel := blobtext.Selection{Limit: blobtext.PostImportLimit, NewestFirst: true, StoredSince: since, RefreshSince: refreshSince}
	summary, err := blobtext.Run(ctx, blobtext.Local{Store: s.db, Blobs: s.blobs}, sel, o, nil)
	if err != nil {
		slog.Error("reading attachment text", "error", err)
		return false
	}
	return summary.Considered == blobtext.PostImportLimit
}

// tempDir is where extraction stages files, under the data dir rather than
// /tmp: documents can be large and tmpfs is small.
func tempDir(dataDir string) string { return filepath.Join(dataDir, "tmp") }

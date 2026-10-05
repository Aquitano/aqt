package server

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/aichat"
	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/discord"
	"github.com/aquitano/aqt/apps/bank/internal/eml"
	"github.com/aquitano/aqt/apps/bank/internal/extract"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/generic"
	"github.com/aquitano/aqt/apps/bank/internal/linkedin"
	"github.com/aquitano/aqt/apps/bank/internal/mediaimport"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/whatsapp"
	"github.com/aquitano/aqt/apps/bank/internal/youtube"
)

// Uploads are always single files: directory inputs stay a client concern, the
// CLI walks them and posts one file per request.
func (s *Server) handleImport(w http.ResponseWriter, r *http.Request) {
	received := time.Now()
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload)
	kind := r.PathValue("kind")
	source := r.URL.Query().Get("source")
	dateOrder := r.URL.Query().Get("date_order")
	if dateOrder != "" && (kind != "netflix" || dateOrder != "mdy" && dateOrder != "dmy") {
		writeErr(w, http.StatusBadRequest, "date_order requires a Netflix import and must be mdy or dmy")
		return
	}
	// The source names a directory under the archive root and arrives here
	// straight from a query string, so it is checked before any bytes are
	// written rather than deep inside an importer.
	if source != "" {
		if err := archive.ValidSource(source); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	if kind == "json" {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		res, err := s.importJSON(r.Context(), source, body)
		if err != nil {
			writeCause(w, err)
			return
		}
		writeJSON(w, http.StatusOK, res)
		return
	}

	var observation *eml.MailImportContext
	path, cleanup, err := saveUpload(r, s.dataDir, &observation)
	if err != nil {
		writeCause(w, err)
		return
	}
	defer cleanup()
	if observation != nil && kind != "eml" && kind != "mbox" {
		writeErr(w, http.StatusBadRequest, "mail context requires an EML or MBOX import")
		return
	}

	var res any
	if kind == "netflix" || kind == "youtube-media" || kind == "library" {
		res, err = mediaimport.Import(r.Context(), s.db, s.blobs, s.archiveDir, kind, path, mediaimport.Options{Source: source, Account: r.URL.Query().Get("account"), NetflixDateOrder: dateOrder})
	} else {
		res, err = s.importFile(r.Context(), kind, source, path, observation)
	}
	if err != nil {
		writeCause(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
	s.extractAfterImport(received)
}

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
	if !s.extraction.running || received.Before(s.extraction.since) {
		s.extraction.since = received
	}
	if s.extraction.running {
		s.extraction.again = true
		return
	}
	s.extraction.running = true
	s.extraction.done.Go(s.extractUntilCurrent)
}

type extraction struct {
	mu      sync.Mutex
	running bool
	again   bool
	since   time.Time
	done    sync.WaitGroup
}

// extractUntilCurrent refreshes, after each pass, only what changed since the
// previous pass started, which is earlier than that pass's own refresh and so
// leaves no gap. A cutoff lowered by a late-finishing upload restarts that
// window from the new cutoff.
func (s *Server) extractUntilCurrent() {
	var previous, refreshSince time.Time
	for {
		s.extraction.mu.Lock()
		since := s.extraction.since
		s.extraction.mu.Unlock()
		if previous.IsZero() || since.Before(previous) {
			refreshSince = since
		}
		previous = since
		started := time.Now()
		backlog := s.extractPending(context.Background(), since, refreshSince)
		refreshSince = started
		s.extraction.mu.Lock()
		again := backlog || s.extraction.again
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
	o.TempDir = uploadStagingDir(s.dataDir)
	sel := extract.Selection{Limit: extract.PostImportLimit, NewestFirst: true, StoredSince: since, RefreshSince: refreshSince}
	summary, err := extract.Run(ctx, extract.Local{Store: s.db, Blobs: s.blobs}, sel, o, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "bank: reading attachment text: %v\n", err)
		return false
	}
	return summary.Considered == extract.PostImportLimit
}

func (s *Server) importJSON(ctx context.Context, source string, body []byte) (generic.Result, error) {
	return store.RunImport(ctx, s.db, "json", "upload", func(ctx context.Context) (generic.Result, error) { return s.importJSONInput(ctx, source, body) })
}
func (s *Server) importJSONInput(ctx context.Context, source string, body []byte) (generic.Result, error) {
	sum := sha256.Sum256(body)
	rawRef, err := archive.Write(s.archiveDir, "json", fmt.Sprintf("upload-%x.json", sum[:6]), body)
	if err != nil {
		return generic.Result{}, fail.Opf("archive upload: %w", err)
	}
	// Attachment paths would resolve on the server's filesystem — an arbitrary
	// file-read primitive for token holders, and never what a remote caller
	// means anyway. Local imports keep them.
	return generic.Import(ctx, s.db, s.blobs, source, rawRef, body, time.Now(), false)
}

func (s *Server) importFile(ctx context.Context, kind, source, path string, contexts ...*eml.MailImportContext) (any, error) {
	if source == "" {
		source = map[string]string{"eml": "proton", "mbox": "gmail"}[kind]
	}
	switch kind {
	case "whatsapp":
		return whatsapp.Import(ctx, s.db, s.blobs, s.archiveDir, path)
	case "eml":
		return eml.ImportEmlPath(ctx, s.db, s.blobs, s.archiveDir, source, path, contexts...)
	case "mbox":
		return eml.ImportMbox(ctx, s.db, s.blobs, s.archiveDir, source, path, contexts...)
	case "discord":
		return discord.Import(ctx, s.db, s.archiveDir, path)
	case "linkedin":
		return linkedin.Import(ctx, s.db, s.archiveDir, path)
	case "youtube":
		return youtube.Import(ctx, s.db, s.archiveDir, path)
	case "chatgpt":
		return aichat.ImportChatGPT(ctx, s.db, s.blobs, s.archiveDir, path)
	case "claude":
		return aichat.ImportClaude(ctx, s.db, s.archiveDir, path)
	}
	return nil, fmt.Errorf("unknown import kind %q", kind)
}

// uploadMaxAge is how long a staging directory may sit untouched before it is
// treated as abandoned. Comfortably longer than the slowest plausible upload
// of a Takeout-sized mbox, so an upload in flight is never swept away.
const uploadMaxAge = 24 * time.Hour

func uploadStagingDir(dataDir string) string { return filepath.Join(dataDir, "tmp") }

// pruneUploads removes staging directories left behind by a crash or a
// restart. Nothing else lives under tmp/, and every entry there is named by
// os.MkdirTemp, so age alone is a safe policy.
func pruneUploads(dataDir string, maxAge time.Duration) error {
	staging := uploadStagingDir(dataDir)
	entries, err := os.ReadDir(staging)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	cutoff := time.Now().Add(-maxAge)
	var failures []string
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "upload-") {
			continue
		}
		info, err := e.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		if err := os.RemoveAll(filepath.Join(staging, e.Name())); err != nil {
			failures = append(failures, err.Error())
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("%s: %s", staging, strings.Join(failures, "; "))
	}
	return nil
}

// saveUpload writes the multipart "file" part into a fresh temp dir, keeping the
// original basename — importers derive thread names and sources from it. Staged
// under the data dir, not /tmp: uploads can be Takeout-sized and tmpfs is small.
func saveUpload(r *http.Request, dataDir string, observation **eml.MailImportContext) (string, func(), error) {
	mr, err := r.MultipartReader()
	if err != nil {
		return "", nil, fmt.Errorf("expected multipart/form-data with a file field: %w", err)
	}
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			return "", nil, fmt.Errorf("no file field in upload")
		}
		if err != nil {
			return "", nil, err
		}
		if part.FormName() == "mail_context" {
			if *observation != nil {
				_ = part.Close()
				return "", nil, fmt.Errorf("duplicate mail context field")
			}
			raw, err := io.ReadAll(io.LimitReader(part, archive.MaxMailContextBytes+1))
			if err != nil {
				return "", nil, err
			}
			context, err := archive.DecodeMailContext(raw)
			if err != nil {
				return "", nil, err
			}
			_ = part.Close()
			*observation = context
			continue
		}
		if part.FormName() != "file" {
			part.Close()
			continue
		}
		name := filepath.Base(filepath.FromSlash(part.FileName()))
		if name == "." || name == ".." || name == string(filepath.Separator) || name == "" {
			part.Close()
			return "", nil, fmt.Errorf("upload has no usable filename")
		}
		staging := uploadStagingDir(dataDir)
		if err := os.MkdirAll(staging, 0o700); err != nil {
			part.Close()
			return "", nil, fail.Opf("create upload staging dir: %w", err)
		}
		// Cheap enough to do per upload, and it keeps a long-lived server from
		// accumulating debris between restarts.
		if err := pruneUploads(dataDir, uploadMaxAge); err != nil {
			fmt.Fprintf(os.Stderr, "bank: pruning abandoned uploads: %v\n", err)
		}
		dir, err := os.MkdirTemp(staging, "upload-")
		if err != nil {
			part.Close()
			return "", nil, fail.Opf("create upload staging dir: %w", err)
		}
		cleanup := func() { os.RemoveAll(dir) }
		path := filepath.Join(dir, name)
		f, err := os.Create(path)
		if err != nil {
			part.Close()
			cleanup()
			return "", nil, fail.Opf("create upload file: %w", err)
		}
		_, err = io.Copy(f, part)
		part.Close()
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			cleanup()
			// A write that failed on our own file is the server's disk; a
			// short read is the client's connection dying. Both surface, only
			// the first is a 5xx.
			var pathErr *fs.PathError
			if errors.As(err, &pathErr) {
				return "", nil, fail.Opf("saving upload: %w", err)
			}
			return "", nil, fmt.Errorf("saving upload: %w", err)
		}
		if _, err := mr.NextPart(); !errors.Is(err, io.EOF) {
			cleanup()
			return "", nil, fmt.Errorf("file must be the final multipart field")
		}
		return path, cleanup, nil
	}
}

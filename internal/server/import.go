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
	"time"

	"github.com/aquitano/aqt-bank/internal/aichat"
	"github.com/aquitano/aqt-bank/internal/archive"
	"github.com/aquitano/aqt-bank/internal/discord"
	"github.com/aquitano/aqt-bank/internal/eml"
	"github.com/aquitano/aqt-bank/internal/extract"
	"github.com/aquitano/aqt-bank/internal/fail"
	"github.com/aquitano/aqt-bank/internal/generic"
	"github.com/aquitano/aqt-bank/internal/linkedin"
	"github.com/aquitano/aqt-bank/internal/whatsapp"
)

// Uploads are always single files: directory inputs stay a client concern, the
// CLI walks them and posts one file per request.
func (s *Server) handleImport(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload)
	kind := r.PathValue("kind")
	source := r.URL.Query().Get("source")
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

	path, cleanup, err := saveUpload(r, s.dataDir)
	if err != nil {
		writeCause(w, err)
		return
	}
	defer cleanup()

	res, err := s.importFile(r.Context(), kind, source, path)
	if err != nil {
		writeCause(w, err)
		return
	}
	s.extractAfterImport(r.Context())
	writeJSON(w, http.StatusOK, res)
}

// extractAfterImport reads text out of newly stored attachments so an upload
// is searchable inside its documents straight away. Newest first and bounded:
// the batch has to reach what this upload stored even when a large backlog is
// waiting, and it must not turn one upload into a whole-archive pass.
//
// Only the cheap pure-Go extractors ever run here. OCR needs tesseract and
// poppler, which are deliberately not in this image — the process listening on
// a port holds one static binary and no shell — so scanned documents are
// recorded as needing OCR and read later by `bank extract --ocr`, which can
// run anywhere, including a laptop against this server.
//
// Never fatal: the message and its blobs are already archived, and text is
// derived data that any later pass can rebuild.
func (s *Server) extractAfterImport(ctx context.Context) {
	if os.Getenv("BANK_EXTRACT") == "off" {
		return
	}
	o := extract.DefaultOptions()
	o.TempDir = uploadStagingDir(s.dataDir)
	sel := extract.Selection{Limit: extract.PostImportLimit, NewestFirst: true}
	if _, err := extract.Run(ctx, extract.Local{Store: s.db, Blobs: s.blobs}, sel, o, nil); err != nil {
		fmt.Fprintf(os.Stderr, "bank: reading attachment text: %v\n", err)
	}
}

func (s *Server) importJSON(ctx context.Context, source string, body []byte) (generic.Result, error) {
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

func (s *Server) importFile(ctx context.Context, kind, source, path string) (any, error) {
	if source == "" {
		source = map[string]string{"eml": "proton", "mbox": "gmail"}[kind]
	}
	switch kind {
	case "whatsapp":
		return whatsapp.Import(ctx, s.db, s.blobs, s.archiveDir, path)
	case "eml":
		return eml.ImportEmlPath(ctx, s.db, s.blobs, s.archiveDir, source, path)
	case "mbox":
		return eml.ImportMbox(ctx, s.db, s.blobs, s.archiveDir, source, path)
	case "discord":
		return discord.Import(ctx, s.db, s.archiveDir, path)
	case "linkedin":
		return linkedin.Import(ctx, s.db, s.archiveDir, path)
	case "chatgpt":
		return aichat.ImportChatGPT(ctx, s.db, s.blobs, s.archiveDir, path)
	case "claude":
		return aichat.ImportClaude(ctx, s.db, s.archiveDir, path)
	// The harness kinds sync rather than import: `bank import ai` re-uploads
	// every discovered session on every run, and a file whose exact bytes are
	// already archived was fully ingested last time. Reimport never comes
	// through here — it replays the server's own archive locally.
	case "claude-code":
		return aichat.SyncClaudeCode(ctx, s.db, s.archiveDir, path)
	case "codex":
		return aichat.SyncCodex(ctx, s.db, s.archiveDir, path)
	case "opencode":
		return aichat.SyncOpenCode(ctx, s.db, s.archiveDir, path)
	case "antigravity":
		return aichat.SyncAntigravity(ctx, s.db, s.archiveDir, path)
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
func saveUpload(r *http.Request, dataDir string) (string, func(), error) {
	mr, err := r.MultipartReader()
	if err != nil {
		return "", nil, fmt.Errorf("expected multipart/form-data with a file field: %w", err)
	}
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			return "", nil, fmt.Errorf("no file field in upload")
		}
		if err != nil {
			return "", nil, err
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
		return path, cleanup, nil
	}
}

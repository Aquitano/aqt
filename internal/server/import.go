package server

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/aquitano/aqt-bank/internal/aichat"
	"github.com/aquitano/aqt-bank/internal/archive"
	"github.com/aquitano/aqt-bank/internal/discord"
	"github.com/aquitano/aqt-bank/internal/eml"
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

	if kind == "json" {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		res, err := s.importJSON(r.Context(), source, body)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, res)
		return
	}

	path, cleanup, err := saveUpload(r, s.dataDir)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	defer cleanup()

	res, err := s.importFile(r.Context(), kind, source, path)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) importJSON(ctx context.Context, source string, body []byte) (generic.Result, error) {
	sum := sha256.Sum256(body)
	rawRef, err := archive.Write(s.archiveDir, "json", fmt.Sprintf("upload-%x.json", sum[:6]), body)
	if err != nil {
		return generic.Result{}, err
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
		return aichat.ImportChatGPT(ctx, s.db, s.archiveDir, path)
	case "claude":
		return aichat.ImportClaude(ctx, s.db, s.archiveDir, path)
	case "claude-code":
		return aichat.ImportClaudeCode(ctx, s.db, s.archiveDir, path)
	}
	return nil, fmt.Errorf("unknown import kind %q", kind)
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
		staging := filepath.Join(dataDir, "tmp")
		if err := os.MkdirAll(staging, 0o700); err != nil {
			part.Close()
			return "", nil, err
		}
		dir, err := os.MkdirTemp(staging, "upload-")
		if err != nil {
			part.Close()
			return "", nil, err
		}
		cleanup := func() { os.RemoveAll(dir) }
		path := filepath.Join(dir, name)
		f, err := os.Create(path)
		if err != nil {
			part.Close()
			cleanup()
			return "", nil, err
		}
		_, err = io.Copy(f, part)
		part.Close()
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			cleanup()
			return "", nil, fmt.Errorf("saving upload: %w", err)
		}
		return path, cleanup, nil
	}
}

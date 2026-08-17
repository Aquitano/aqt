package whatsapp

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/aquitano/aqt-bank/internal/blob"
	"github.com/aquitano/aqt-bank/internal/store"
)

type Result struct {
	Thread       string `json:"thread"`
	Inserted     int    `json:"inserted"`
	Duplicates   int    `json:"duplicates"`
	Attachments  int    `json:"attachments"`
	MissingMedia int    `json:"missing_media"`
}

var chatFileName = regexp.MustCompile(`(?i)^WhatsApp Chat (?:with |- )?(.+?)\.(?:txt|zip)$`)

// ThreadName derives the conversation name from an export's filename.
func ThreadName(path string) string {
	base := filepath.Base(path)
	if m := chatFileName.FindStringSubmatch(base); m != nil {
		return m[1]
	}
	return strings.TrimSuffix(base, filepath.Ext(base))
}

// Import ingests one "Export chat" file (.zip with media, or bare .txt whose
// media files sit alongside it). Re-importing the same export is a no-op.
func Import(ctx context.Context, st *store.Store, blobs *blob.Store, archiveDir, path string) (Result, error) {
	var res Result
	res.Thread = ThreadName(path)

	var chat io.Reader
	// openMedia returns a reader for a media file referenced by the chat, or nil.
	var openMedia func(name string) io.ReadCloser

	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".zip":
		zr, err := zip.OpenReader(path)
		if err != nil {
			return res, err
		}
		defer zr.Close()
		byName := map[string]*zip.File{}
		var chatFile *zip.File
		for _, f := range zr.File {
			byName[filepath.Base(f.Name)] = f
			if strings.HasSuffix(f.Name, ".txt") && (chatFile == nil || strings.Contains(f.Name, "_chat") || strings.Contains(f.Name, "WhatsApp Chat")) {
				chatFile = f
			}
		}
		if chatFile == nil {
			return res, fmt.Errorf("%s: no chat .txt inside zip", path)
		}
		rc, err := chatFile.Open()
		if err != nil {
			return res, err
		}
		defer rc.Close()
		chat = rc
		openMedia = func(name string) io.ReadCloser {
			f, ok := byName[name]
			if !ok {
				return nil
			}
			r, err := f.Open()
			if err != nil {
				return nil
			}
			return r
		}
		if res.Thread == "" || strings.EqualFold(res.Thread, "_chat") {
			res.Thread = ThreadName(strings.TrimSuffix(path, ext))
		}
	case ".txt":
		f, err := os.Open(path)
		if err != nil {
			return res, err
		}
		defer f.Close()
		chat = f
		dir := filepath.Dir(path)
		openMedia = func(name string) io.ReadCloser {
			r, err := os.Open(filepath.Join(dir, name))
			if err != nil {
				return nil
			}
			return r
		}
	default:
		return res, fmt.Errorf("%s: expected a .zip or .txt WhatsApp export", path)
	}

	msgs, err := ParseChat(chat)
	if err != nil {
		return res, err
	}
	if len(msgs) == 0 {
		return res, fmt.Errorf("%s: no messages parsed — not a WhatsApp export?", path)
	}

	rawRef, err := archiveOriginal(archiveDir, path)
	if err != nil {
		return res, err
	}

	for _, pm := range msgs {
		sum := sha256.Sum256([]byte(res.Thread + "\x00" + pm.SentAt.UTC().Format("2006-01-02T15:04:05") + "\x00" + pm.Sender + "\x00" + pm.Body + "\x00" + pm.AttachmentName))
		id, err := st.InsertMessage(ctx, store.Message{
			Source:     "whatsapp",
			ExternalID: hex.EncodeToString(sum[:]),
			ThreadID:   res.Thread,
			Sender:     pm.Sender,
			Body:       pm.Body,
			SentAt:     pm.SentAt,
			RawRef:     rawRef,
		})
		if err != nil {
			return res, err
		}
		if id == 0 {
			res.Duplicates++
			continue
		}
		res.Inserted++

		if pm.AttachmentName == "" {
			continue
		}
		media := openMedia(pm.AttachmentName)
		if media == nil {
			res.MissingMedia++
			continue
		}
		sumHex, size, err := blobs.Put(media)
		media.Close()
		if err != nil {
			return res, err
		}
		err = st.InsertAttachment(ctx, store.Attachment{
			MessageID: id,
			Filename:  pm.AttachmentName,
			MimeType:  mime.TypeByExtension(filepath.Ext(pm.AttachmentName)),
			SizeBytes: size,
			SHA256:    sumHex,
		})
		if err != nil {
			return res, err
		}
		res.Attachments++
	}
	return res, nil
}

// archiveOriginal copies the input into archive/whatsapp/ under a
// content-hash prefix so distinct exports with the same name never collide.
func archiveOriginal(archiveDir, path string) (string, error) {
	src, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer src.Close()
	h := sha256.New()
	if _, err := io.Copy(h, src); err != nil {
		return "", err
	}
	prefix := hex.EncodeToString(h.Sum(nil))[:12]

	dir := filepath.Join(archiveDir, "whatsapp")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	rel := filepath.Join("whatsapp", prefix+"-"+filepath.Base(path))
	dest := filepath.Join(archiveDir, rel)
	if _, err := os.Stat(dest); err == nil {
		return rel, nil
	}
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	out, err := os.Create(dest)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(out, src); err != nil {
		out.Close()
		return "", err
	}
	return rel, out.Close()
}

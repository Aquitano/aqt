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

	"github.com/aquitano/aqt-bank/internal/archive"
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

var (
	chatFileName   = regexp.MustCompile(`(?i)^WhatsApp Chat (?:with |- )?(.+?)\.(?:txt|zip)$`)
	downloadSuffix = regexp.MustCompile(`\s\(\d+\)$`)
)

// ThreadName derives the conversation name from an export's filename.
// Browser re-download suffixes (" (1)") are stripped: the thread name feeds
// the message digest, so it must be stable across downloads.
func ThreadName(path string) string {
	base := filepath.Base(path)
	name := strings.TrimSuffix(base, filepath.Ext(base))
	if m := chatFileName.FindStringSubmatch(base); m != nil {
		name = m[1]
	}
	return downloadSuffix.ReplaceAllString(name, "")
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

	rawRef, err := archive.Copy(archiveDir, "whatsapp", path)
	if err != nil {
		return res, err
	}

	seen := map[string]int{}
	for _, pm := range msgs {
		externalID := messageDigest(res.Thread, pm, seen)
		id, err := st.InsertMessage(ctx, store.Message{
			Source:     "whatsapp",
			ExternalID: externalID,
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
			// Heal attachments: an earlier import of the same chat without
			// media (bare .txt, or "export without media") inserted the
			// message but couldn't store the file.
			if pm.AttachmentName != "" {
				if err := healAttachment(ctx, st, blobs, openMedia, externalID, pm.AttachmentName, &res); err != nil {
					return res, err
				}
			}
			continue
		}
		res.Inserted++

		if pm.AttachmentName == "" {
			continue
		}
		if err := storeAttachment(ctx, st, blobs, openMedia, id, pm.AttachmentName, &res); err != nil {
			return res, err
		}
	}
	return res, nil
}

// messageDigest derives a stable external_id. Wall-clock time is hashed as
// written in the export (never converted through a zone) so the same file
// imported on machines in different timezones dedups; identical messages in
// the same minute get an occurrence counter so none are dropped.
func messageDigest(thread string, pm ParsedMessage, seen map[string]int) string {
	base := thread + "\x00" + pm.SentAt.Format("2006-01-02T15:04:05") + "\x00" + pm.Sender + "\x00" + pm.Body + "\x00" + pm.AttachmentName
	n := seen[base]
	seen[base] = n + 1
	if n > 0 {
		base += fmt.Sprintf("\x00%d", n)
	}
	sum := sha256.Sum256([]byte(base))
	return hex.EncodeToString(sum[:])
}

func storeAttachment(ctx context.Context, st *store.Store, blobs *blob.Store, openMedia func(string) io.ReadCloser, messageID int64, name string, res *Result) error {
	media := openMedia(name)
	if media == nil {
		res.MissingMedia++
		return nil
	}
	sumHex, size, err := blobs.Put(media)
	media.Close()
	if err != nil {
		return err
	}
	err = st.InsertAttachment(ctx, store.Attachment{
		MessageID: messageID,
		Filename:  name,
		MimeType:  mime.TypeByExtension(filepath.Ext(name)),
		SizeBytes: size,
		SHA256:    sumHex,
	})
	if err != nil {
		return err
	}
	res.Attachments++
	return nil
}

func healAttachment(ctx context.Context, st *store.Store, blobs *blob.Store, openMedia func(string) io.ReadCloser, externalID, name string, res *Result) error {
	id, err := st.FindMessageID(ctx, "whatsapp", externalID)
	if err != nil || id == 0 {
		return err
	}
	has, err := st.MessageHasAttachments(ctx, id)
	if err != nil || has {
		return err
	}
	return storeAttachment(ctx, st, blobs, openMedia, id, name, res)
}

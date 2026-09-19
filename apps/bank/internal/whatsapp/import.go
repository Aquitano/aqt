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

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/store"
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

// safeMediaName accepts only a single path component that cannot escape the
// export directory. Zip imports are already confined — entries are looked up
// by base name in the archive's own table — so this guards the bare .txt case,
// where the name reaches the host filesystem.
func safeMediaName(name string) bool {
	if name == "" || name == "." || name == ".." || filepath.IsAbs(name) {
		return false
	}
	if strings.ContainsAny(name, `/\`) || strings.HasPrefix(name, "~") {
		return false
	}
	return filepath.Base(name) == name
}

// Import ingests one "Export chat" file (.zip with media, or bare .txt whose
// media files sit alongside it). Re-importing the same export is a no-op.
func Import(ctx context.Context, st *store.Store, blobs *blob.Store, archiveDir, path string) (Result, error) {
	return store.RunImport(ctx, st, "whatsapp", path, func(ctx context.Context) (Result, error) {
		return importUnreported(ctx, st, blobs, archiveDir, path)
	})
}

func importUnreported(ctx context.Context, st *store.Store, blobs *blob.Store, archiveDir, path string) (Result, error) {
	var res Result
	res.Thread = ThreadName(path)

	var chat io.Reader
	// openMedia returns a reader for a media file referenced by the chat, or nil.
	var openMedia func(name string) io.ReadCloser
	// hasMedia reports whether the export ships a file by that name; it gates
	// the localized attachment markers ParseChat may otherwise misread.
	var hasMedia func(name string) bool

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
		hasMedia = func(name string) bool {
			_, ok := byName[name]
			return ok
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
			// Attachment names come out of the chat transcript, which anyone
			// in the conversation can write: "../../.ssh/id_rsa (file
			// attached)" is a legal line. Only a plain filename sitting next
			// to the export may be opened.
			if !safeMediaName(name) {
				fmt.Fprintf(os.Stderr, "bank: ignoring unsafe attachment name %q in %s\n", name, path)
				return nil
			}
			r, err := os.Open(filepath.Join(dir, name))
			if err != nil {
				return nil
			}
			return r
		}
		hasMedia = func(name string) bool {
			if !safeMediaName(name) {
				return false
			}
			_, err := os.Stat(filepath.Join(dir, name))
			return err == nil
		}
	default:
		return res, fmt.Errorf("%s: expected a .zip or .txt WhatsApp export", path)
	}

	msgs, err := ParseChat(chat, hasMedia)
	if err != nil {
		return res, err
	}
	if len(msgs) == 0 {
		return res, fmt.Errorf("%s: no messages parsed — not a WhatsApp export?", path)
	}

	rawRef, err := archive.Copy(archiveDir, "whatsapp", path)
	if err != nil {
		return res, fail.Opf("archive %s: %w", path, err)
	}

	seen := map[string]int{}
	externalIDs := make([]string, 0, len(msgs))
	messages := make([]store.Message, 0, len(msgs))
	for _, pm := range msgs {
		externalID := messageDigest(res.Thread, pm, seen)
		externalIDs = append(externalIDs, externalID)
		messages = append(messages, store.Message{
			Source:     "whatsapp",
			ExternalID: externalID,
			ThreadID:   res.Thread,
			Sender:     pm.Sender,
			Body:       pm.Body,
			SentAt:     pm.SentAt,
			RawRef:     rawRef,
		})
	}
	ids, err := st.InsertMessages(ctx, messages, store.InsertMessagesOpts{})
	if err != nil {
		return res, fail.Opf("insert messages: %w", err)
	}
	for i, pm := range msgs {
		externalID, id := externalIDs[i], ids[i]
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
// the same minute get an occurrence counter so none are dropped. The media
// filename stays out of the digest and "<Media omitted>" bodies hash as
// empty, so a without-media export and a with-media export of the same chat
// produce the same ids (letting healAttachment fill in the media later);
// captions are lossy in without-media exports, so captioned media can still
// duplicate — inherent to the format.
func messageDigest(thread string, pm ParsedMessage, seen map[string]int) string {
	body := pm.Body
	if IsMediaOmitted(body) {
		body = ""
	}
	base := thread + "\x00" + pm.SentAt.Format("2006-01-02T15:04:05") + "\x00" + pm.Sender + "\x00" + body
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
		store.ImportIssue(ctx, fmt.Sprintf("Missing WhatsApp media %s in message %d", name, messageID))
		return nil
	}
	sumHex, size, err := blobs.Put(media)
	media.Close()
	if err != nil {
		return fail.Opf("store attachment %q: %w", name, err)
	}
	err = st.InsertAttachment(ctx, store.Attachment{
		MessageID: messageID,
		Filename:  name,
		MimeType:  mime.TypeByExtension(filepath.Ext(name)),
		SizeBytes: size,
		SHA256:    sumHex,
	})
	if err != nil {
		return fail.Opf("insert attachment %q: %w", name, err)
	}
	res.Attachments++
	return nil
}

func healAttachment(ctx context.Context, st *store.Store, blobs *blob.Store, openMedia func(string) io.ReadCloser, externalID, name string, res *Result) error {
	id, err := st.FindMessageID(ctx, "whatsapp", externalID)
	if err != nil {
		return fail.Opf("look up message: %w", err)
	}
	if id == 0 {
		return nil
	}
	has, err := st.MessageHasAttachments(ctx, id)
	if err != nil {
		return fail.Opf("read attachments of message %d: %w", id, err)
	}
	if has {
		return nil
	}
	return storeAttachment(ctx, st, blobs, openMedia, id, name, res)
}

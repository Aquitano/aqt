package whatsapp

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/export"
	"github.com/aquitano/aqt/apps/bank/internal/fieldhash"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
)

// Source reads one "Export chat" file: a zip with its media, or a bare .txt
// whose media did not come along.
type Source struct{}

type Options struct{}

func (Source) Kind() string { return "whatsapp" }

var (
	chatFileName   = regexp.MustCompile(`(?i)^WhatsApp Chat (?:with |- )?(.+?)\.(?:txt|zip)$`)
	downloadSuffix = regexp.MustCompile(`\s\(\d+\)$`)
)

// ThreadName derives the conversation name from an export's filename.
// Browser re-download suffixes (" (1)") are stripped: the thread name feeds
// the message digest, so it must be stable across downloads.
func ThreadName(name string) string {
	base := filepath.Base(name)
	thread := strings.TrimSuffix(base, filepath.Ext(base))
	if m := chatFileName.FindStringSubmatch(base); m != nil {
		thread = m[1]
	}
	return downloadSuffix.ReplaceAllString(thread, "")
}

func (Source) Parse(ctx context.Context, raw ingest.Raw, _ Options, out ingest.Emitter) error {
	thread := ThreadName(raw.Name)
	exp, err := export.Open(raw)
	if err != nil {
		return err
	}
	defer exp.Close()

	var chat io.ReadCloser
	// media maps a file name in the export to its path there. Names are
	// transcript text anyone in the chat can write, so they are only ever
	// looked up in the export's own table.
	media := map[string]string{}
	switch {
	case exp.FS != nil:
		var chatFile string
		err := fs.WalkDir(exp.FS, ".", func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			media[path.Base(p)] = p
			if strings.HasSuffix(p, ".txt") && (chatFile == "" || strings.Contains(p, "_chat") || strings.Contains(p, "WhatsApp Chat")) {
				chatFile = p
			}
			return nil
		})
		if err != nil {
			return err
		}
		if chatFile == "" {
			return fmt.Errorf("no chat .txt inside the zip")
		}
		if chat, err = exp.FS.Open(chatFile); err != nil {
			return err
		}
	case strings.EqualFold(filepath.Ext(raw.Name), ".txt"):
		if chat, err = raw.Open(); err != nil {
			return err
		}
	default:
		return fmt.Errorf("expected a .zip or .txt WhatsApp export")
	}
	defer chat.Close()

	msgs, err := ParseChat(chat, func(name string) bool { _, ok := media[name]; return ok })
	if err != nil {
		return err
	}
	if len(msgs) == 0 {
		return fmt.Errorf("no messages parsed — not a WhatsApp export?")
	}
	seen := map[string]int{}
	for i, pm := range msgs {
		m := ingest.Message{
			Source:     "whatsapp",
			ExternalID: messageDigest(thread, pm, seen),
			ThreadID:   thread,
			Sender:     pm.Sender,
			Body:       pm.Body,
			SentAt:     pm.SentAt,
			Locator:    fmt.Sprintf("message %d", i+1),
		}
		if pm.AttachmentName != "" {
			part := ingest.Part{Filename: pm.AttachmentName}
			if p, ok := media[pm.AttachmentName]; ok {
				part.Open = func() (io.ReadCloser, error) { return exp.FS.Open(p) }
			}
			m.Parts = []ingest.Part{part}
		}
		if err := out.Message(m); err != nil {
			return err
		}
	}
	return nil
}

// messageDigest derives a stable external_id. Wall-clock time is hashed as
// written in the export (never converted through a zone) so the same file
// imported on machines in different timezones dedups; identical messages in
// the same minute get an occurrence counter so none are dropped. The media
// filename stays out of the digest and "<Media omitted>" bodies hash as
// empty, so a without-media export and a with-media export of the same chat
// produce the same ids, and the later one adds the media at the same
// position; captions are lossy in without-media exports, so captioned media
// can still duplicate — inherent to the format.
func messageDigest(thread string, pm ParsedMessage, seen map[string]int) string {
	body := pm.Body
	if IsMediaOmitted(body) {
		body = ""
	}
	fields := []string{thread, pm.SentAt.Format("2006-01-02T15:04:05"), pm.Sender, body}
	digest := fieldhash.Hex(fields...)
	n := seen[digest]
	seen[digest] = n + 1
	if n > 0 {
		return fieldhash.Hex(append(fields, strconv.Itoa(n))...)
	}
	return digest
}

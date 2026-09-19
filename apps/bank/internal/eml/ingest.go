package eml

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

type IngestOpts struct {
	Source     string
	ExternalID string // default: Message-ID header, else sha256 of the raw bytes
	ThreadID   string
	SentAt     time.Time // overrides the Date header (e.g. Gmail internalDate)
	RawRef     string
}

// maxWarnings bounds how many parser complaints one Result carries; the count
// stays exact either way.
const maxWarnings = 20

type Result struct {
	Inserted    int `json:"inserted"`
	Duplicates  int `json:"duplicates"`
	Attachments int `json:"attachments"`
	// Healed counts attachment rows that repaired an already-archived message
	// whose blobs never made it the first time.
	Healed int `json:"healed"`
	// Rejected counts input the parser could not read. Operational failures —
	// database, archive, blob store, cancellation — abort instead of landing
	// here, so this number always means "the source data was bad".
	Rejected int      `json:"rejected"`
	Damaged  int      `json:"damaged,omitempty"` // messages whose MIME structure had to be salvaged
	Warnings []string `json:"warnings,omitempty"`
}

func (r *Result) note(warnings []string) {
	if len(warnings) == 0 {
		return
	}
	r.Damaged++
	for _, w := range warnings {
		if len(r.Warnings) < maxWarnings {
			r.Warnings = append(r.Warnings, w)
		}
	}
}

// IngestResult reports what one raw email did to the archive.
type IngestResult struct {
	Inserted    bool
	Attachments int      // attachment rows written
	Healed      int      // of those, rows that repaired an earlier partial import
	Warnings    []string // MIME structure the parser had to salvage
}

// Ingest parses one raw email and stores it with its attachments. A message
// that is already archived still has its attachments reconciled: an earlier
// run can have died between the message row and the blobs, and stopping at
// deduplication would leave that damage permanent.
//
// A parse failure is returned as an ordinary error; every database, archive
// and blob-store failure is wrapped with fail.Op so callers can tell "this
// message was malformed" from "the archive is broken".
func Ingest(ctx context.Context, st *store.Store, blobs *blob.Store, raw []byte, o IngestOpts) (IngestResult, error) {
	m, err := Parse(raw)
	if err != nil {
		return IngestResult{}, err
	}
	res := IngestResult{Warnings: m.Warnings}

	externalID := o.ExternalID
	if externalID == "" {
		externalID = defaultExternalID(m, raw)
	}
	sentAt := o.SentAt
	if sentAt.IsZero() {
		sentAt = m.Date
	}
	if sentAt.IsZero() {
		sentAt = time.Unix(0, 0) // unknown date: an obvious epoch sentinel beats a fake-recent one
	}

	// Message-ID dedups across id schemes: a mail synced via the Gmail API
	// (external_id = API id) and the same mail from a Takeout mbox
	// (external_id = Message-ID) must not both be inserted.
	id, err := st.FindByEmailMessageID(ctx, o.Source, m.MessageID)
	if err != nil {
		return res, fail.Opf("look up message-id %q: %w", m.MessageID, err)
	}
	if id == 0 {
		id, err = st.InsertMessage(ctx, store.Message{
			Source:     o.Source,
			ExternalID: externalID,
			MessageID:  m.MessageID,
			ThreadID:   o.ThreadID,
			Sender:     m.From,
			Recipients: append(m.To, m.Cc...),
			Subject:    m.Subject,
			Body:       m.Body,
			SentAt:     sentAt,
			RawRef:     o.RawRef,
		})
		if err != nil {
			return res, fail.Opf("insert message: %w", err)
		}
		if id != 0 {
			res.Inserted = true
		} else if id, err = st.FindMessageID(ctx, o.Source, externalID); err != nil {
			return res, fail.Opf("look up message: %w", err)
		}
	}
	if id == 0 {
		// Insert lost a race on the Message-ID index against a concurrent
		// worker; that worker owns the attachments.
		return res, nil
	}
	return res, syncAttachments(ctx, st, blobs, id, m.Attachments, res.Inserted, &res)
}

// defaultExternalID is what a message is keyed by when the caller names no id
// of its own: the Message-ID, or the raw bytes' digest for mail that carries
// none. Shared with the body healer, which has to find a row again under the
// same identity the import gave it.
func defaultExternalID(m *Message, raw []byte) string {
	if m.MessageID != "" {
		return m.MessageID
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// syncAttachments stores the attachments a message does not already have,
// matching on content and filename so a partially stored multi-attachment
// message heals only what is missing.
func syncAttachments(ctx context.Context, st *store.Store, blobs *blob.Store, messageID int64, atts []Attachment, fresh bool, res *IngestResult) error {
	if len(atts) == 0 {
		return nil
	}
	have := map[string]int{}
	if !fresh {
		var err error
		if have, err = st.AttachmentKeys(ctx, messageID); err != nil {
			return fail.Opf("read attachments of message %d: %w", messageID, err)
		}
	}
	for _, a := range atts {
		sum := sha256.Sum256(a.Data)
		key := store.AttachmentKey(hex.EncodeToString(sum[:]), a.Filename)
		if have[key] > 0 {
			have[key]--
			continue
		}
		stored, size, err := blobs.Put(bytes.NewReader(a.Data))
		if err != nil {
			return fail.Opf("store attachment %q: %w", a.Filename, err)
		}
		err = st.InsertAttachment(ctx, store.Attachment{
			MessageID: messageID,
			Filename:  a.Filename,
			MimeType:  a.MimeType,
			SizeBytes: size,
			SHA256:    stored,
		})
		if err != nil {
			return fail.Opf("insert attachment %q: %w", a.Filename, err)
		}
		res.Attachments++
		if !fresh {
			res.Healed++
		}
	}
	return nil
}

func (r *Result) record(out IngestResult) {
	if out.Inserted {
		r.Inserted++
	} else {
		r.Duplicates++
	}
	r.Attachments += out.Attachments
	r.Healed += out.Healed
	r.note(out.Warnings)
}

// ImportEmlPath ingests a single .eml file, or every .eml under a directory
// (the layout proton-mail-export produces).
func ImportEmlPath(ctx context.Context, st *store.Store, blobs *blob.Store, archiveDir, source, path string) (Result, error) {
	return store.RunImport(ctx, st, "eml", path, func(ctx context.Context) (Result, error) {
		return importEmlPathUnreported(ctx, st, blobs, archiveDir, source, path)
	})
}

func importEmlPathUnreported(ctx context.Context, st *store.Store, blobs *blob.Store, archiveDir, source, path string) (Result, error) {
	var res Result
	if err := archive.ValidSource(source); err != nil {
		return res, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return res, err
	}
	one := func(p string) error {
		raw, err := os.ReadFile(p)
		if err != nil {
			return fail.Opf("read %s: %w", p, err)
		}
		rel, err := archive.Copy(archiveDir, source, p)
		if err != nil {
			return fail.Opf("archive %s: %w", p, err)
		}
		out, err := Ingest(ctx, st, blobs, raw, IngestOpts{Source: source, RawRef: rel})
		if err != nil {
			if fail.IsOp(err) {
				return err
			}
			res.Rejected++
			fmt.Fprintf(os.Stderr, "bank: rejecting %s: %v\n", p, err)
			return nil
		}
		res.record(out)
		return nil
	}
	if !info.IsDir() {
		return res, one(path)
	}
	err = filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.EqualFold(filepath.Ext(p), ".eml") {
			return err
		}
		return one(p)
	})
	return res, err
}

// ImportMbox ingests a Gmail Takeout style .mbox file.
func ImportMbox(ctx context.Context, st *store.Store, blobs *blob.Store, archiveDir, source, path string) (Result, error) {
	return store.RunImport(ctx, st, "mbox", path, func(ctx context.Context) (Result, error) {
		return importMboxUnreported(ctx, st, blobs, archiveDir, source, path)
	})
}

func importMboxUnreported(ctx context.Context, st *store.Store, blobs *blob.Store, archiveDir, source, path string) (Result, error) {
	var res Result
	if err := archive.ValidSource(source); err != nil {
		return res, err
	}
	rel, err := archive.Copy(archiveDir, source, path)
	if err != nil {
		return res, fail.Opf("archive %s: %w", path, err)
	}
	f, err := os.Open(path)
	if err != nil {
		return res, err
	}
	defer f.Close()
	var only []byte
	messages := 0
	err = SplitMbox(f, func(raw []byte) error {
		messages++
		if messages == 1 {
			only = raw
		} else {
			only = nil
		}
		out, err := Ingest(ctx, st, blobs, raw, IngestOpts{Source: source, RawRef: rel})
		if err != nil {
			if fail.IsOp(err) {
				return err
			}
			res.Rejected++
			fmt.Fprintf(os.Stderr, "bank: rejecting malformed mbox message: %v\n", err)
			return nil
		}
		res.record(out)
		return nil
	})
	if err == nil && messages == 1 && looksUnsplit(only) {
		fmt.Fprintf(os.Stderr, "bank: %s: read as ONE message, but its body still contains mbox separator lines — "+
			"the file is likely in a dialect the splitter does not know and its messages were merged. "+
			"Do not delete the export; report the separator line.\n", path)
	}
	return res, err
}

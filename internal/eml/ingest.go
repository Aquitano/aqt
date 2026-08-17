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

	"github.com/aquitano/aqt-bank/internal/archive"
	"github.com/aquitano/aqt-bank/internal/blob"
	"github.com/aquitano/aqt-bank/internal/store"
)

type IngestOpts struct {
	Source     string
	ExternalID string // default: Message-ID header, else sha256 of the raw bytes
	ThreadID   string
	SentAt     time.Time // overrides the Date header (e.g. Gmail internalDate)
	RawRef     string
}

type Result struct {
	Inserted    int `json:"inserted"`
	Duplicates  int `json:"duplicates"`
	Attachments int `json:"attachments"`
	Failed      int `json:"failed"`
}

// Ingest parses one raw email and stores it with its attachments.
// Returns false when the message was already archived.
func Ingest(ctx context.Context, st *store.Store, blobs *blob.Store, raw []byte, o IngestOpts) (bool, int, error) {
	m, err := Parse(raw)
	if err != nil {
		return false, 0, err
	}
	externalID := o.ExternalID
	if externalID == "" {
		externalID = m.MessageID
	}
	if externalID == "" {
		sum := sha256.Sum256(raw)
		externalID = hex.EncodeToString(sum[:])
	}
	sentAt := o.SentAt
	if sentAt.IsZero() {
		sentAt = m.Date
	}
	if sentAt.IsZero() {
		sentAt = time.Unix(0, 0) // unknown date: an obvious epoch sentinel beats a fake-recent one
	}

	id, err := st.InsertMessage(ctx, store.Message{
		Source:     o.Source,
		ExternalID: externalID,
		ThreadID:   o.ThreadID,
		Sender:     m.From,
		Recipients: append(m.To, m.Cc...),
		Subject:    m.Subject,
		Body:       m.Body,
		SentAt:     sentAt,
		RawRef:     o.RawRef,
	})
	if err != nil || id == 0 {
		return false, 0, err
	}
	stored := 0
	for _, a := range m.Attachments {
		sum, size, err := blobs.Put(bytes.NewReader(a.Data))
		if err != nil {
			return true, stored, err
		}
		err = st.InsertAttachment(ctx, store.Attachment{
			MessageID: id,
			Filename:  a.Filename,
			MimeType:  a.MimeType,
			SizeBytes: size,
			SHA256:    sum,
		})
		if err != nil {
			return true, stored, err
		}
		stored++
	}
	return true, stored, nil
}

// ImportEmlPath ingests a single .eml file, or every .eml under a directory
// (the layout proton-mail-export produces).
func ImportEmlPath(ctx context.Context, st *store.Store, blobs *blob.Store, archiveDir, source, path string) (Result, error) {
	var res Result
	info, err := os.Stat(path)
	if err != nil {
		return res, err
	}
	one := func(p string) error {
		raw, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		rel, err := archive.Copy(archiveDir, source, p)
		if err != nil {
			return err
		}
		inserted, atts, err := Ingest(ctx, st, blobs, raw, IngestOpts{Source: source, RawRef: rel})
		if err != nil {
			res.Failed++
			fmt.Fprintf(os.Stderr, "bank: skipping %s: %v\n", p, err)
			return nil
		}
		if inserted {
			res.Inserted++
			res.Attachments += atts
		} else {
			res.Duplicates++
		}
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
	var res Result
	rel, err := archive.Copy(archiveDir, source, path)
	if err != nil {
		return res, err
	}
	f, err := os.Open(path)
	if err != nil {
		return res, err
	}
	defer f.Close()
	err = SplitMbox(f, func(raw []byte) error {
		inserted, atts, err := Ingest(ctx, st, blobs, raw, IngestOpts{Source: source, RawRef: rel})
		if err != nil {
			res.Failed++
			fmt.Fprintf(os.Stderr, "bank: skipping malformed mbox message: %v\n", err)
			return nil
		}
		if inserted {
			res.Inserted++
			res.Attachments += atts
		} else {
			res.Duplicates++
		}
		return nil
	})
	return res, err
}

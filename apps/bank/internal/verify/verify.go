// Package verify checks that the archive still holds what the database claims,
// and repairs what the archived raw inputs can rebuild.
//
// Three things can drift apart: the message rows, the attachment rows, and the
// bytes on disk (raw inputs under archive/, attachment content under blobs/).
// An import that died between writing a row and writing its bytes leaves
// damage that no later import notices, because deduplication stops at the
// message row. This is the pass that finds it.
package verify

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/eml"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// Kinds of damage, stable strings so JSON consumers can branch on them.
const (
	MissingRaw         = "missing_raw"         // raw_ref names an archive file that is gone
	MissingBlob        = "missing_blob"        // attachment row without bytes
	CorruptBlob        = "corrupt_blob"        // bytes do not hash to the recorded digest
	WrongSize          = "wrong_size"          // bytes exist but size_bytes lies
	MissingAttachments = "missing_attachments" // the archived mail carries attachments the database does not
)

type Finding struct {
	MessageID    int64  `json:"message_id"`
	AttachmentID int64  `json:"attachment_id,omitempty"`
	Kind         string `json:"kind"`
	Detail       string `json:"detail"`
	// Repaired is true when --heal rebuilt this from the archived raw input.
	Repaired bool `json:"repaired"`
}

type Report struct {
	MessagesChecked    int64     `json:"messages_checked"`
	AttachmentsChecked int64     `json:"attachments_checked"`
	Damaged            int       `json:"damaged"`
	Repaired           int       `json:"repaired"`
	Unrecoverable      int       `json:"unrecoverable"`
	Findings           []Finding `json:"findings"`
}

type Options struct {
	// Source limits the walk to one source; empty means the whole archive.
	Source string
	// Heal rewrites what the archived raw input can deterministically rebuild.
	// Without it the pass is strictly read-only.
	Heal bool
}

// maxFindings bounds the report so a badly damaged archive still returns
// something printable. The counters keep counting past it.
const maxFindings = 500

// Run walks the archive and reports what it cannot account for.
func Run(ctx context.Context, st *store.Store, blobs *blob.Store, archiveDir string, o Options) (Report, error) {
	rep := Report{Findings: []Finding{}}
	v := &verifier{st: st, blobs: blobs, archiveDir: archiveDir, opts: o, rep: &rep}
	err := st.EachArchivedMessage(ctx, o.Source, func(m store.ArchivedMessage) error {
		return v.message(ctx, m)
	})
	return rep, err
}

type verifier struct {
	st         *store.Store
	blobs      *blob.Store
	archiveDir string
	opts       Options
	rep        *Report
	// raw caches the parse of the message currently being checked, so a mail
	// with five broken attachments is read from disk once.
	rawPath string
	rawMail *eml.Message
}

func (v *verifier) message(ctx context.Context, m store.ArchivedMessage) error {
	v.rep.MessagesChecked++
	v.rawPath, v.rawMail = "", nil

	rawOK := true
	if m.RawRef != "" {
		if _, err := os.Stat(v.rawFile(m.RawRef)); err != nil {
			rawOK = false
			v.add(Finding{MessageID: m.ID, Kind: MissingRaw, Detail: m.RawRef}, false)
		}
	}

	for _, a := range m.Attachments {
		v.rep.AttachmentsChecked++
		if err := v.attachment(ctx, m, a, rawOK); err != nil {
			return err
		}
	}
	return v.missingAttachments(ctx, m, rawOK)
}

// rawFile resolves a raw_ref. Refs are relative to the archive root; a
// directory-input importer (Discord unpacked packages) stores an absolute path
// instead, which is left alone.
func (v *verifier) rawFile(ref string) string {
	if filepath.IsAbs(ref) {
		return ref
	}
	return filepath.Join(v.archiveDir, ref)
}

func (v *verifier) attachment(ctx context.Context, m store.ArchivedMessage, a store.Attachment, rawOK bool) error {
	path := v.blobs.Path(a.SHA256)
	info, err := os.Stat(path)
	if err != nil {
		return v.repairBlob(ctx, m, a, rawOK, MissingBlob, "no bytes in the blob store")
	}
	sum, err := hashFile(path)
	if err != nil {
		return err
	}
	if sum != a.SHA256 {
		return v.repairBlob(ctx, m, a, rawOK, CorruptBlob, "content hashes to "+sum)
	}
	if info.Size() == a.SizeBytes {
		return nil
	}
	// The bytes hash correctly, so the row's size is the wrong half. That is
	// repairable without consulting the raw input at all.
	f := Finding{MessageID: m.ID, AttachmentID: a.ID, Kind: WrongSize,
		Detail: fmt.Sprintf("size_bytes says %d, file is %d", a.SizeBytes, info.Size())}
	if !v.opts.Heal {
		v.add(f, false)
		return nil
	}
	if err := v.st.SetAttachmentSize(ctx, a.ID, info.Size()); err != nil {
		return err
	}
	v.add(f, true)
	return nil
}

// repairBlob rewrites an attachment's bytes from the archived raw input when
// that input still carries content with the same digest — the only case where
// the repair is provably the original content and not a guess.
func (v *verifier) repairBlob(ctx context.Context, m store.ArchivedMessage, a store.Attachment, rawOK bool, kind, detail string) error {
	f := Finding{MessageID: m.ID, AttachmentID: a.ID, Kind: kind, Detail: detail}
	if !v.opts.Heal || !rawOK {
		v.add(f, false)
		return nil
	}
	data := v.recoverPart(m, a.SHA256)
	if data == nil {
		v.add(f, false)
		return nil
	}
	if _, size, err := v.blobs.Replace(bytes.NewReader(data)); err != nil {
		return err
	} else if size != a.SizeBytes {
		if err := v.st.SetAttachmentSize(ctx, a.ID, size); err != nil {
			return err
		}
		f.Detail += fmt.Sprintf("; size corrected to %d", size)
	}
	v.add(f, true)
	return nil
}

// errFoundPart stops an mbox walk once the wanted digest turned up.
var errFoundPart = fmt.Errorf("found")

// recoverPart returns the bytes inside the archived raw input whose sha256
// matches digest, or nil. The digest match is the safety: whatever the
// container — a single mail, a WhatsApp export zip, an mbox — matching
// content is the original by definition.
func (v *verifier) recoverPart(m store.ArchivedMessage, digest string) []byte {
	switch strings.ToLower(filepath.Ext(m.RawRef)) {
	case ".eml":
		mail, err := v.parsedRaw(m)
		if err != nil || mail == nil {
			return nil
		}
		for _, part := range mail.Attachments {
			if hashBytes(part.Data) == digest {
				return part.Data
			}
		}
	case ".zip":
		zr, err := zip.OpenReader(v.rawFile(m.RawRef))
		if err != nil {
			return nil
		}
		defer zr.Close()
		for _, zf := range zr.File {
			if zf.FileInfo().IsDir() {
				continue
			}
			rc, err := zf.Open()
			if err != nil {
				continue
			}
			data, err := io.ReadAll(rc)
			rc.Close()
			if err == nil && hashBytes(data) == digest {
				return data
			}
		}
	case ".mbox":
		f, err := os.Open(v.rawFile(m.RawRef))
		if err != nil {
			return nil
		}
		defer f.Close()
		var found []byte
		err = eml.SplitMbox(f, func(raw []byte) error {
			mail, err := eml.Parse(raw)
			if err != nil {
				return nil // one unparseable message must not end the search
			}
			for _, part := range mail.Attachments {
				if hashBytes(part.Data) == digest {
					found = part.Data
					return errFoundPart
				}
			}
			return nil
		})
		if err == nil || err == errFoundPart {
			return found
		}
	}
	return nil
}

func hashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// missingAttachments compares the archived mail against the attachment rows.
// Only single-message raw inputs (.eml) are checked: a container (mbox, zip)
// would have to be re-split to find the one message, which belongs to an
// import, not to a check.
func (v *verifier) missingAttachments(ctx context.Context, m store.ArchivedMessage, rawOK bool) error {
	if !rawOK || !strings.EqualFold(filepath.Ext(m.RawRef), ".eml") {
		return nil
	}
	mail, err := v.parsedRaw(m)
	if err != nil || mail == nil || len(mail.Attachments) == 0 {
		return nil
	}
	have := map[string]int{}
	for _, a := range m.Attachments {
		have[store.AttachmentKey(a.SHA256, a.Filename)]++
	}
	var missing []eml.Attachment
	for _, part := range mail.Attachments {
		sum := sha256.Sum256(part.Data)
		key := store.AttachmentKey(hex.EncodeToString(sum[:]), part.Filename)
		if have[key] > 0 {
			have[key]--
			continue
		}
		missing = append(missing, part)
	}
	if len(missing) == 0 {
		return nil
	}
	f := Finding{
		MessageID: m.ID,
		Kind:      MissingAttachments,
		Detail:    fmt.Sprintf("%d attachment(s) in %s are not in the database", len(missing), m.RawRef),
	}
	if !v.opts.Heal {
		v.add(f, false)
		return nil
	}
	for _, part := range missing {
		sum, size, err := v.blobs.Put(bytes.NewReader(part.Data))
		if err != nil {
			return err
		}
		err = v.st.InsertAttachment(ctx, store.Attachment{
			MessageID: m.ID,
			Filename:  part.Filename,
			MimeType:  part.MimeType,
			SizeBytes: size,
			SHA256:    sum,
		})
		if err != nil {
			return err
		}
	}
	v.add(f, true)
	return nil
}

func (v *verifier) parsedRaw(m store.ArchivedMessage) (*eml.Message, error) {
	if m.RawRef == "" || !strings.EqualFold(filepath.Ext(m.RawRef), ".eml") {
		return nil, nil
	}
	path := v.rawFile(m.RawRef)
	if v.rawPath == path {
		return v.rawMail, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, nil // already reported as MissingRaw
	}
	mail, err := eml.Parse(raw)
	if err != nil {
		return nil, nil
	}
	v.rawPath, v.rawMail = path, mail
	return mail, nil
}

func (v *verifier) add(f Finding, repaired bool) {
	f.Repaired = repaired
	v.rep.Damaged++
	if repaired {
		v.rep.Repaired++
	} else {
		v.rep.Unrecoverable++
	}
	if len(v.rep.Findings) < maxFindings {
		v.rep.Findings = append(v.rep.Findings, f)
	}
}

func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

package importer

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// batchSize bounds the messages one transaction writes. Attachment bytes are
// in the blob store by then, so a batch holds only rows.
const batchSize = 500

// sink is the Emitter every source writes through. It stores a message's
// attachment bytes when the message is emitted, then writes the message with
// its attachment rows in one transaction with the rest of its batch: a crash
// can leave a blob nothing names, which is harmless, but never a message
// without its attachments.
type sink struct {
	ctx     context.Context
	t       Target
	rawID   int64
	report  ingest.Report
	pending []store.Record
}

func newSink(ctx context.Context, t Target, rawID int64) *sink {
	return &sink{ctx: ctx, t: t, rawID: rawID, report: ingest.NewReport()}
}

func (s *sink) Issue(issue ingest.Issue) { s.report.Add(issue) }

func (s *sink) Message(m ingest.Message) error {
	if err := s.ctx.Err(); err != nil {
		return err
	}
	if err := ingest.ValidSource(m.Source); err != nil {
		return err
	}
	record := store.Record{Message: store.Message{
		Source: m.Source, ExternalID: m.ExternalID, MessageID: m.MessageID, ThreadID: m.ThreadID,
		Sender: m.Sender, Recipients: m.Recipients, Subject: m.Subject, Body: m.Body, SentAt: m.SentAt,
		ParentExternalID: m.ParentExternalID, BranchID: m.BranchID, AlternativeIndex: m.AlternativeIndex,
		RawInput: s.rawID, RawLocator: m.Locator,
	}}
	for position, part := range m.Parts {
		if part.Open == nil {
			s.Issue(ingest.Issuef(ingest.MissingMedia, "%s is not in the input (message %s)", part.Filename, m.ExternalID))
			continue
		}
		attachment, err := s.storePart(part)
		if err != nil {
			return err
		}
		attachment.Position = position
		record.Attachments = append(record.Attachments, attachment)
	}
	if m.Mail != nil {
		record.Mail = &store.Mail{HeaderID: m.Mail.NormalizedMessageID, InReplyTo: m.Mail.InReplyTo, References: m.Mail.References}
		if m.Mail.Mailbox != nil {
			record.Mail.Mailbox = &store.MailboxObservation{Kind: m.Mail.Mailbox.Kind, Paths: m.Mail.Mailbox.Paths}
		}
	}
	s.pending = append(s.pending, record)
	if len(s.pending) >= batchSize {
		return s.flush()
	}
	return nil
}

// storePart streams one attachment into the blob store. Many exported files
// carry no usable extension, so the first bytes name the type when nothing
// else does.
func (s *sink) storePart(part ingest.Part) (store.Attachment, error) {
	rc, err := part.Open()
	if err != nil {
		return store.Attachment{}, fmt.Errorf("open attachment %q: %w", part.Filename, err)
	}
	defer rc.Close()
	buffered := bufio.NewReader(rc)
	mimeType := part.MimeType
	if mimeType == "" {
		mimeType = mime.TypeByExtension(filepath.Ext(part.Filename))
	}
	if mimeType == "" {
		head, _ := buffered.Peek(512)
		mimeType = http.DetectContentType(head)
	}
	digest, size, err := s.t.Blobs.Put(s.ctx, buffered)
	if err != nil {
		var pathErr *os.PathError
		if errors.As(err, &pathErr) || errors.Is(err, context.Canceled) {
			return store.Attachment{}, fail.Opf("store attachment %q: %w", part.Filename, err)
		}
		return store.Attachment{}, fmt.Errorf("read attachment %q: %w", part.Filename, err)
	}
	return store.Attachment{Filename: part.Filename, MimeType: mimeType, SizeBytes: size, BLAKE3: digest}, nil
}

// flush writes the pending batch in one transaction, threads included.
func (s *sink) flush() error {
	if len(s.pending) == 0 {
		return nil
	}
	written, err := s.t.Store.WriteMessages(s.ctx, s.pending)
	if err != nil {
		return fail.Opf("write messages: %w", err)
	}
	for _, w := range written {
		switch {
		case w.Inserted:
			s.report.Inserted++
		case w.ID == 0:
			s.report.Retired++
		default:
			s.report.Duplicates++
		}
		s.report.Attachments += w.Attachments
	}
	s.pending = s.pending[:0]
	return nil
}

func (s *sink) Library(batch library.ImportBatch) error {
	if err := s.flush(); err != nil {
		return err
	}
	if err := batch.Validate(); err != nil {
		return err
	}
	if err := s.checkFiles(batch.Files); err != nil {
		return err
	}
	at := func(p *library.Provenance) { p.RawInput = s.rawID }
	for i := range batch.Items {
		at(&batch.Items[i].Provenance)
		for j := range batch.Items[i].Evidence {
			at(&batch.Items[i].Evidence[j])
		}
	}
	for i := range batch.Activity {
		at(&batch.Activity[i].Provenance)
		for j := range batch.Activity[i].Evidence {
			at(&batch.Activity[i].Evidence[j])
		}
	}
	for i := range batch.Collections {
		if snapshot := batch.Collections[i].Snapshot; snapshot != nil {
			at(&snapshot.Provenance)
		}
	}
	for i := range batch.Files {
		at(&batch.Files[i].Provenance)
	}
	if len(batch.Pages) > 0 {
		return fmt.Errorf("pages are published through Pages, not a library batch")
	}
	result, err := s.t.Store.ImportLibrary(s.ctx, batch)
	if err != nil {
		return libraryFailure(err)
	}
	s.addLibrary(result)
	return nil
}

func (s *sink) Pages(p ingest.Pages) error {
	if err := s.flush(); err != nil {
		return err
	}
	for i := range p.Pages {
		p.Pages[i].Provenance.RawInput = s.rawID
	}
	result, err := s.t.Store.PublishLibraryPages(s.ctx, p.Source, p.Account, p.Pages)
	if err != nil {
		return libraryFailure(err)
	}
	s.addLibrary(result)
	return nil
}

func (s *sink) addLibrary(r library.ImportResult) {
	l := &s.report.Library
	l.Duplicates += r.Duplicates
	l.Items += r.Items
	l.Activity += r.Activity
	l.Collections += r.Collections
	l.Files += r.Files
	l.Pages += r.Pages
}

// checkFiles refuses a library file whose bytes are not already in the blob
// store under its digest and size: a bundle names files, it does not carry
// them.
func (s *sink) checkFiles(files []library.File) error {
	for _, file := range files {
		input, err := os.Open(s.t.Blobs.Path(file.BLAKE3))
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("file %s has no preserved bytes", file.Filename)
		}
		if err != nil {
			return fail.Opf("read preserved file %s: %w", file.Filename, err)
		}
		sum, size, err := content.Hash(s.ctx, input)
		closeErr := input.Close()
		if err = errors.Join(err, closeErr); err != nil {
			return fail.Op(err)
		}
		if sum != file.BLAKE3 {
			return fail.Opf("preserved file %s has corrupted bytes", file.Filename)
		}
		if size != file.SizeBytes {
			return fmt.Errorf("file %s does not match its declared size", file.Filename)
		}
	}
	return nil
}

// libraryFailure keeps a batch the database refused as the input's fault, and
// everything else as the archive's.
func libraryFailure(err error) error {
	var pgErr *pgconn.PgError
	if errors.Is(err, library.ErrConflict) || errors.Is(err, library.ErrInvalid) ||
		(errors.As(err, &pgErr) && (strings.HasPrefix(pgErr.Code, "22") || strings.HasPrefix(pgErr.Code, "23") || pgErr.Code == "54000")) {
		return err
	}
	return fail.Op(err)
}

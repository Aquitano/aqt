package eml

import (
	"bytes"
	"cmp"
	"context"
	"fmt"
	"io"
	"io/fs"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/export"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
)

// EML reads one .eml file, or a zip of them such as a packed
// proton-mail-export directory.
type EML struct{}

// Mbox reads one mbox file, such as Gmail Takeout's or a Thunderbird folder.
type Mbox struct{}

func (EML) Kind() string  { return "eml" }
func (Mbox) Kind() string { return "mbox" }

// EMLOptions are what an importer knows about mail beyond its bytes. Gmail
// sync and the IMAP collector set the fields that apply to one message.
type EMLOptions struct {
	Source string `json:"source" help:"Mail account the messages are filed under. Default: proton."`
	// Mailbox is the folder the input was observed in; empty records none.
	Mailbox string `json:"mailbox,omitempty" help:"Folder the file came from, kept as a historical observation."`
	// MailboxKind tells an export folder from an IMAP folder.
	MailboxKind string `json:"mailbox_kind,omitempty" kong:"-"`
	// Labels are further IMAP folders the message was seen in, such as Gmail
	// labels.
	Labels     []string  `json:"labels,omitempty" kong:"-"`
	ExternalID string    `json:"external_id,omitempty" kong:"-"`
	ThreadID   string    `json:"thread_id,omitempty" kong:"-"`
	SentAt     time.Time `json:"sent_at,omitzero" kong:"-"`
}

type MboxOptions struct {
	Source  string `json:"source" help:"Mail account the messages are filed under. Default: gmail."`
	Mailbox string `json:"mailbox,omitempty" help:"Folder the file came from, kept as a historical observation."`
}

func (o *EMLOptions) Normalize() error {
	if o.Source == "" {
		o.Source = "proton"
	}
	if o.Mailbox != "" && o.MailboxKind == "" {
		o.MailboxKind = "export"
	}
	if err := ingest.ValidSource(o.Source); err != nil {
		return err
	}
	if o.Mailbox == "" && (o.MailboxKind != "" || len(o.Labels) > 0) {
		return fmt.Errorf("a mailbox kind or labels need a mailbox")
	}
	if o.MailboxKind != "" && o.MailboxKind != "export" && o.MailboxKind != "imap" {
		return fmt.Errorf("mailbox kind must be export or imap")
	}
	if len(o.Labels) > 0 && o.MailboxKind != "imap" {
		return fmt.Errorf("labels need an IMAP mailbox")
	}
	for _, value := range append([]string{o.Mailbox, o.ExternalID, o.ThreadID}, o.Labels...) {
		if !validMailValue(value) {
			return fmt.Errorf("invalid or overlong mail option %q", value)
		}
	}
	for _, label := range o.Labels {
		if label == "" {
			return fmt.Errorf("a label is empty")
		}
	}
	return nil
}

func (o *MboxOptions) Normalize() error {
	if o.Source == "" {
		o.Source = "gmail"
	}
	if !validMailValue(o.Mailbox) {
		return fmt.Errorf("invalid or overlong mailbox %q", o.Mailbox)
	}
	return ingest.ValidSource(o.Source)
}

func validMailValue(value string) bool {
	return len(value) <= 4096 && utf8.ValidString(value) && !strings.ContainsAny(value, "\x00\r\n")
}

func (o EMLOptions) mailbox() *ingest.Mailbox {
	if o.Mailbox == "" {
		return nil
	}
	return &ingest.Mailbox{Kind: o.MailboxKind, Paths: append([]string{o.Mailbox}, o.Labels...)}
}

func (EML) Parse(ctx context.Context, raw ingest.Raw, opts EMLOptions, out ingest.Emitter) error {
	if !export.IsZip(raw.Name) {
		data, err := readAll(raw)
		if err != nil {
			return err
		}
		return emit(data, opts, "", false, out)
	}
	if opts.ExternalID != "" || opts.ThreadID != "" || !opts.SentAt.IsZero() {
		return fmt.Errorf("an external id, thread id or date applies to one message, not a zip")
	}
	exp, err := export.Open(raw)
	if err != nil {
		return err
	}
	defer exp.Close()
	return fs.WalkDir(exp.FS, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.EqualFold(path.Ext(name), ".eml") {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		data, err := fs.ReadFile(exp.FS, name)
		if err != nil {
			out.Issue(ingest.Issuef(ingest.Rejected, "%s: %v", name, err))
			return nil
		}
		return emit(data, opts, name, false, out)
	})
}

func (Mbox) Parse(ctx context.Context, raw ingest.Raw, opts MboxOptions, out ingest.Emitter) error {
	f, err := raw.Open()
	if err != nil {
		return err
	}
	defer f.Close()
	options := EMLOptions{Source: opts.Source, Mailbox: opts.Mailbox}
	if opts.Mailbox != "" {
		options.MailboxKind = "export"
	}
	var only []byte
	n := 0
	err = SplitMbox(f, func(data []byte) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		n++
		if n == 1 {
			only = data
		} else {
			only = nil
		}
		return emit(data, options, fmt.Sprintf("message %d", n), opts.Source == "gmail", out)
	})
	if err != nil {
		return err
	}
	if n == 1 && looksUnsplit(only) {
		out.Issue(ingest.Issuef(ingest.Incomplete, "read as one message, but its body still contains mbox separator lines; "+
			"the file is likely in a dialect the splitter does not know"))
	}
	return nil
}

func readAll(raw ingest.Raw) ([]byte, error) {
	f, err := raw.Open()
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

// emit parses one message and hands it on. A message the parser cannot read
// is rejected on its own; the rest of its input still imports. takeout reads
// Gmail's X-GM-THRID header, which only a Gmail Takeout mbox can be trusted
// to carry.
func emit(data []byte, opts EMLOptions, locator string, takeout bool, out ingest.Emitter) error {
	m, err := Parse(data)
	if err != nil {
		out.Issue(ingest.Issuef(ingest.Rejected, "%s: %v", cmp.Or(locator, "message"), err))
		return nil
	}
	if len(m.Warnings) > 0 {
		out.Issue(ingest.Issuef(ingest.Damaged, "%s: %s", cmp.Or(locator, strconv.Quote(m.MessageID)), strings.Join(m.Warnings, "; ")))
	}
	externalID := opts.ExternalID
	if externalID == "" {
		externalID = defaultExternalID(m, data)
	}
	sentAt := opts.SentAt
	if sentAt.IsZero() {
		sentAt = m.Date
	}
	threadID := m.nativeThreadID(opts.ThreadID, takeout)
	parts := make([]ingest.Part, len(m.Attachments))
	for i, a := range m.Attachments {
		parts[i] = ingest.Part{Filename: a.Filename, MimeType: a.MimeType, Open: func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(a.Data)), nil
		}}
	}
	return out.Message(ingest.Message{
		Source:     opts.Source,
		ExternalID: externalID,
		MessageID:  m.MessageID,
		ThreadID:   threadID,
		Sender:     m.From,
		Recipients: append(m.To, m.Cc...),
		Subject:    m.Subject,
		Body:       m.Body,
		SentAt:     sentAt,
		Locator:    locator,
		Parts:      parts,
		Mail: &ingest.Mail{
			NormalizedMessageID: m.NormalizedMessageID,
			InReplyTo:           m.InReplyTo,
			References:          m.References,
			NativeThreadID:      threadID,
			Mailbox:             opts.mailbox(),
		},
	})
}

// defaultExternalID is what a message is keyed by when the caller names no id
// of its own: the Message-ID, or for mail that carries none the BLAKE3 digest
// of its raw bytes, which for a single message is its raw input's digest.
func defaultExternalID(m *Message, raw []byte) string {
	if m.MessageID != "" {
		return m.MessageID
	}
	return content.Sum(raw).String()
}

// Package ingest is the contract between a source, which parses one raw input
// into records, and the importer, which stores the input and what its source
// emits. A source reads only its input and its options: it never writes to
// the database or the blob store. OpenExport opens an input the way most
// exporters ship one, as a zip.
package ingest

import (
	"context"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/library"
)

// Raw is one stored input. Its bytes stay where the importer put them.
type Raw struct {
	// Name is the input's original file name. A directory arrives as the zip
	// the CLI packed it into, named after the directory with ".zip" added.
	Name string
	Path string
}

func (r Raw) Open() (*os.File, error) { return os.Open(r.Path) }

// Source parses one kind of input. O is its options type: options decode
// strictly from JSON, are stored with the input, and are passed again on
// replay. Parse returns an error only for an input it cannot read at all; a
// record it cannot read is an Issue.
type Source[O any] interface {
	Kind() string
	Parse(ctx context.Context, raw Raw, opts O, out Emitter) error
}

// Normalizer is implemented by an options type, on its pointer, that fills
// defaults and validates before an input is stored.
type Normalizer interface {
	Normalize() error
}

// Emitter receives a source's records. Message and Library may store a batch
// before they return; an error from them is the importer's and ends the
// parse.
type Emitter interface {
	Message(Message) error
	Library(library.ImportBatch) error
	// Pages replaces every published page of one source and account.
	Pages(Pages) error
	Issue(Issue)
}

type Message struct {
	Source     string
	ExternalID string
	MessageID  string
	ThreadID   string
	Sender     string
	Recipients []string
	Subject    string
	Body       string
	// SentAt is zero when the input does not say when the message was sent.
	SentAt           time.Time
	ParentExternalID string
	BranchID         string
	AlternativeIndex int
	// Locator says where in the input the record was read, when the input
	// holds more than one.
	Locator string
	// Parts are the message's attachments in the order the record names
	// them. A part's index is its position, so it keeps its place when an
	// export that lacked it is followed by one that has it.
	Parts []Part
	Mail  *Mail
}

type Part struct {
	Filename string
	// MimeType may be empty; the importer then guesses it from the name and
	// the first bytes.
	MimeType string
	// Open is nil when the record names an attachment its input does not hold.
	// The importer reports it as missing media.
	Open func() (io.ReadCloser, error)
}

// Mail is what the mail projection needs beyond the message row.
type Mail struct {
	NormalizedMessageID string
	InReplyTo           []string
	References          []string
	Mailbox             *Mailbox
}

// Mailbox is the folder a mail was observed in. Paths holds the folder and,
// for Gmail over IMAP, its labels.
type Mailbox struct {
	Kind  string
	Paths []string
}

type Pages struct {
	Source  string
	Account string
	Pages   []library.Page
}

type IssueKind string

const (
	// MissingMedia: a record names an attachment its input does not hold.
	MissingMedia IssueKind = "missing_media"
	// Rejected: a record or nested file the parser could not read.
	Rejected IssueKind = "rejected"
	// Skipped: a record with nothing to store, such as an empty row.
	Skipped IssueKind = "skipped"
	// Unsupported: content the parser does not represent.
	Unsupported IssueKind = "unsupported"
	// Damaged: a record read by salvaging a broken structure.
	Damaged IssueKind = "damaged"
	// Incomplete: the input or a projection of it is known to be partial,
	// such as missing shards or mail grouping past its limits.
	Incomplete IssueKind = "incomplete"
	// Dropped: records left out on purpose, such as advertisements. The only
	// kind that does not make an import's status gaps.
	Dropped IssueKind = "dropped"
)

type Issue struct {
	Kind   IssueKind `json:"kind"`
	Detail string    `json:"detail"`
}

func Issuef(kind IssueKind, format string, args ...any) Issue {
	return Issue{Kind: kind, Detail: fmt.Sprintf(format, args...)}
}

// maxDetails bounds the issue details one report keeps; Issues counts every
// issue either way.
const maxDetails = 100

// Report is what one import did.
type Report struct {
	Inserted    int                  `json:"inserted"`
	Duplicates  int                  `json:"duplicates"`
	Retired     int                  `json:"retired"`
	Attachments int                  `json:"attachments"`
	Library     library.ImportResult `json:"library"`
	Issues      map[IssueKind]int    `json:"issues"`
	Details     []Issue              `json:"details"`
}

func NewReport() Report {
	return Report{Issues: map[IssueKind]int{}, Details: []Issue{}}
}

// Add counts an issue and keeps its detail, made safe for a database text
// column: details quote input that may hold NUL bytes or invalid UTF-8.
func (r *Report) Add(issue Issue) {
	issue.Detail = strings.ReplaceAll(strings.ToValidUTF8(issue.Detail, "\uFFFD"), "\x00", "")
	r.Issues[issue.Kind]++
	if len(r.Details) < maxDetails {
		r.Details = append(r.Details, issue)
	}
}

// Status is complete, or gaps when anything but a deliberate drop was lost.
func (r Report) Status() string {
	for kind, n := range r.Issues {
		if kind != Dropped && n > 0 {
			return "gaps"
		}
	}
	return "complete"
}

// Stored counts the records the import added to the archive.
func (r Report) Stored() int {
	l := r.Library
	return r.Inserted + l.Items + l.Activity + l.Collections + l.Files + l.Pages
}

// Known counts the records the archive already held.
func (r Report) Known() int { return r.Duplicates + r.Retired + r.Library.Duplicates }

var sourceName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// ValidSource checks a source name, which arrives from flags, options and
// query strings and is shown and filtered on everywhere.
func ValidSource(source string) error {
	if source == "" {
		return fmt.Errorf("source must not be empty")
	}
	if !sourceName.MatchString(source) || strings.Contains(source, "..") {
		return fmt.Errorf("invalid source %q: use letters, digits, '.', '_' or '-', starting with a letter or digit", source)
	}
	return nil
}

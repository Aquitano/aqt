// Package extract turns attachment bytes into searchable text.
//
// Extraction is deliberately not part of importing. It is derived data —
// rebuildable from the blobs at any time — and it is keyed on the blob's
// sha256, so a PDF attached to forty messages is read once. Keeping it a
// separate pass is also what lets the expensive half (OCR) run somewhere other
// than the process that serves the archive over a network port.
package extract

import (
	"context"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aquitano/aqt-bank/internal/store"
)

// Status is what an extraction attempt concluded. It is stored per blob so a
// later pass can retry a subset — after installing tesseract, after adding an
// extractor — without re-reading everything.
type Status string

const (
	// StatusOK: text was recovered and indexed.
	StatusOK Status = "ok"
	// StatusEmpty: the extractor understood the file and it holds no text.
	// A blank spreadsheet is not a failure and must not be retried forever.
	StatusEmpty Status = "empty"
	// StatusNeedsOCR: an image, or a PDF with no text layer. Nothing is
	// wrong; the text is pixels and OCR did not run. This is the work queue
	// for `bank extract --ocr`.
	StatusNeedsOCR Status = "needs_ocr"
	// StatusUnsupported: no extractor handles this type (video, archives,
	// binaries). Retried only when an extractor is added.
	StatusUnsupported Status = "unsupported"
	// StatusTooBig: over MaxBytes. Recorded rather than skipped silently so
	// the count is visible.
	StatusTooBig Status = "too_big"
	// StatusFailed: the extractor errored or the file is corrupt.
	StatusFailed Status = "failed"
	// StatusManual: set by hand, or by a model running on the client.
	// Automatic passes never overwrite it.
	StatusManual Status = "manual"
)

// Statuses lists every status, for flag validation and reporting order.
var Statuses = []Status{StatusOK, StatusEmpty, StatusNeedsOCR, StatusUnsupported, StatusTooBig, StatusFailed, StatusManual}

// ValidStatus keeps a typo in --status from silently selecting nothing. The
// pending pseudo-status counts: it is what a caller names to mean content no
// extraction has touched, and leaving it out of the message would make a valid
// choice look wrong.
func ValidStatus(s string) error {
	if s == store.StatusPending || ValidStoredStatus(s) == nil {
		return nil
	}
	return unknownStatus(s, append([]string{store.StatusPending}, statusNames()...))
}

// ValidStoredStatus is the same check for a status about to be written to a
// row, which is a stricter question than which content to select: pending
// means "no row at all", so storing it would leave content that no default
// pass ever looks at again. The HTTP write route takes its status from a query
// string, and that is the one place a caller can invent one.
func ValidStoredStatus(s string) error {
	for _, k := range Statuses {
		if Status(s) == k {
			return nil
		}
	}
	return unknownStatus(s, statusNames())
}

// ValidRunStatus is the same check for content an automatic pass may work on.
// Manual text is a transcription someone made by hand or with better tools
// than this binary has; re-running extraction over it would replace it with
// whatever tesseract makes of the same page, and nothing could rebuild it.
func ValidRunStatus(s string) error {
	if s == string(StatusManual) {
		return fmt.Errorf("--status manual would overwrite transcriptions made by hand: " +
			"replace one with `bank attachment text <sha256> --set`, " +
			"or clear it with `--clear` to put the content back in the queue")
	}
	return ValidStatus(s)
}

func statusNames() []string {
	names := make([]string, 0, len(Statuses))
	for _, k := range Statuses {
		names = append(names, string(k))
	}
	return names
}

func unknownStatus(s string, names []string) error {
	return fmt.Errorf("unknown status %q (want one of: %s)", s, strings.Join(names, ", "))
}

// Result is one extraction attempt.
type Result struct {
	Text string
	// Extractor names what produced the text, so a later pass can tell an
	// OCR'd body from a parsed one without a second column of meaning.
	Extractor string
	Status    Status
	// Err carries why a failure failed. Never fatal to a run: one corrupt PDF
	// must not stop the pass.
	Err error
}

// Options bound what extraction is allowed to cost and which tools it may use.
type Options struct {
	// OCR enables the image and no-text-layer-PDF path. Off by default: it
	// needs external binaries, and it is minutes per document where every
	// other extractor is milliseconds.
	OCR bool
	// OCRLang is passed to tesseract as -l. Multiple languages are joined
	// with '+' by tesseract itself ("deu+eng").
	OCRLang string
	// MaxBytes skips blobs larger than this. A 2 GB video has no text worth
	// the read.
	MaxBytes int64
	// MaxChars truncates stored text. Bounds both the index and the row.
	MaxChars int
	// OCRMaxPages bounds rasterizing a long scanned PDF.
	OCRMaxPages int
	// Timeout bounds one document, OCR included.
	Timeout time.Duration
	// TempDir is where OCR rasterizes pages. Defaults to the OS temp dir;
	// the CLI points it at the data directory, which is the one writable
	// mount in the container and is sized for archive-scale files.
	TempDir string
	// Tesseract and PDFToPPM are the binaries to run, overridable for tests
	// and for a box that installed them somewhere unusual.
	Tesseract string
	PDFToPPM  string
}

// DefaultOptions are what the CLI uses before flags are applied.
func DefaultOptions() Options {
	return Options{
		OCRLang:     "eng",
		MaxBytes:    64 << 20,
		MaxChars:    1 << 20,
		OCRMaxPages: 20,
		Timeout:     5 * time.Minute,
		Tesseract:   "tesseract",
		PDFToPPM:    "pdftoppm",
	}
}

func (o Options) withDefaults() Options {
	d := DefaultOptions()
	if o.OCRLang == "" {
		o.OCRLang = d.OCRLang
	}
	if o.MaxBytes <= 0 {
		o.MaxBytes = d.MaxBytes
	}
	if o.MaxChars <= 0 {
		o.MaxChars = d.MaxChars
	}
	if o.OCRMaxPages <= 0 {
		o.OCRMaxPages = d.OCRMaxPages
	}
	if o.Timeout <= 0 {
		o.Timeout = d.Timeout
	}
	if o.Tesseract == "" {
		o.Tesseract = d.Tesseract
	}
	if o.PDFToPPM == "" {
		o.PDFToPPM = d.PDFToPPM
	}
	return o
}

// kind is the extractor family chosen for a file.
type kind int

const (
	kindNone kind = iota
	kindText
	kindHTML
	kindZipXML // OOXML and OpenDocument: both are a zip of XML parts
	kindPDF
	kindImage
)

// File extracts text from one file on disk. filename and mimeType come from
// the attachment row; both are attacker-supplied in the sense that they came
// out of someone else's mail client, so neither is trusted beyond choosing an
// extractor.
//
// It never returns an error: every outcome is a Status, because a run over
// thousands of blobs must record what happened to each and continue.
func File(ctx context.Context, path, filename, mimeType string, o Options) Result {
	o = o.withDefaults()

	info, err := os.Stat(path)
	if err != nil {
		return Result{Status: StatusFailed, Err: err}
	}
	if info.Size() > o.MaxBytes {
		return Result{Status: StatusTooBig}
	}
	if info.Size() == 0 {
		return Result{Status: StatusEmpty}
	}

	ctx, cancel := context.WithTimeout(ctx, o.Timeout)
	defer cancel()

	switch classify(filename, mimeType) {
	case kindText:
		return run("text", o, func() (string, error) { return readPlain(path, o) })
	case kindHTML:
		return run("html", o, func() (string, error) { return readHTML(path, o) })
	case kindZipXML:
		return run("zipxml", o, func() (string, error) { return readZipXML(path, o) })
	case kindPDF:
		return pdfResult(ctx, path, o)
	case kindImage:
		if !o.OCR {
			return Result{Status: StatusNeedsOCR}
		}
		return run("ocr", o, func() (string, error) { return tesseract(ctx, path, o) })
	}
	return Result{Status: StatusUnsupported}
}

// run calls one extractor and turns its (text, error) into a Result, applying
// the character cap and the empty-versus-ok distinction in one place.
func run(extractor string, o Options, f func() (string, error)) Result {
	text, err := f()
	if err != nil {
		return Result{Status: StatusFailed, Extractor: extractor, Err: err}
	}
	text = normalize(text, o.MaxChars)
	if text == "" {
		return Result{Status: StatusEmpty, Extractor: extractor}
	}
	return Result{Text: text, Extractor: extractor, Status: StatusOK}
}

// classify picks an extractor family from the filename first and the declared
// MIME type second. Mail clients mislabel attachments constantly — this
// archive already carries a whole code path for malformed Content-Type — and
// the extension is what the sender's own software chose.
func classify(filename, mimeType string) kind {
	if k := byExt(strings.ToLower(filepath.Ext(filename))); k != kindNone {
		return k
	}
	return byMIME(mimeType)
}

func byExt(ext string) kind {
	switch ext {
	case ".txt", ".text", ".log", ".md", ".markdown", ".csv", ".tsv", ".json", ".ndjson",
		".yaml", ".yml", ".ini", ".conf", ".toml", ".rtf", ".vcf", ".ics", ".srt", ".vtt", ".sql":
		return kindText
	case ".html", ".htm", ".xhtml":
		return kindHTML
	case ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp":
		return kindZipXML
	case ".pdf":
		return kindPDF
	case ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif", ".webp", ".heic":
		return kindImage
	}
	return kindNone
}

func byMIME(mimeType string) kind {
	mt, _, err := mime.ParseMediaType(mimeType)
	if err != nil {
		mt = strings.ToLower(strings.TrimSpace(strings.Split(mimeType, ";")[0]))
	}
	switch mt {
	case "text/html", "application/xhtml+xml":
		return kindHTML
	case "application/pdf", "application/x-pdf":
		return kindPDF
	case "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		"application/vnd.oasis.opendocument.text",
		"application/vnd.oasis.opendocument.spreadsheet",
		"application/vnd.oasis.opendocument.presentation":
		return kindZipXML
	case "application/json", "application/xml", "text/xml", "application/x-ndjson":
		return kindText
	}
	if strings.HasPrefix(mt, "text/") {
		return kindText
	}
	if strings.HasPrefix(mt, "image/") {
		return kindImage
	}
	return kindNone
}

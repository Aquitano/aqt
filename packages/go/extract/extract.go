// Package extract turns a file's bytes into searchable text: plain text, HTML,
// Office and OpenDocument files, PDF text layers, and with OCR images and
// scanned PDFs. bank reads mail attachments with it, attic files on backup
// disks. Each keeps its own queue; this package knows one file at a time.
package extract

import (
	"context"
	"io"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Status is what an extraction attempt concluded. Callers store it per
// content so a later pass can retry a subset — after installing tesseract,
// after adding an extractor — without re-reading everything.
type Status string

const (
	// StatusOK: text was recovered and indexed.
	StatusOK Status = "ok"
	// StatusEmpty: the extractor understood the file and it holds no text.
	// A blank spreadsheet is not a failure and must not be retried forever.
	StatusEmpty Status = "empty"
	// StatusNeedsOCR: an image, or a PDF with no text layer. Nothing is
	// wrong; the text is pixels and OCR did not run. This is the work queue
	// for an OCR pass.
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

// Result is one extraction attempt.
type Result struct {
	Text string
	// Extractor names what produced the text, so a later pass can tell an
	// OCR'd body from a parsed one without a second column of meaning.
	Extractor string
	Status    Status
	// Truncated marks omitted text or OCR pages. Status can be ok or empty
	// depending on whether the completed portion contains any text.
	Truncated bool
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
	// MaxBytes skips files larger than this. A 2 GB video has no text worth
	// the read.
	MaxBytes int64
	// MaxChars truncates stored text. Bounds both the index and the row.
	MaxChars int
	// OCRMaxPages bounds rasterizing a long scanned PDF.
	OCRMaxPages int
	// Timeout bounds one document, OCR included.
	Timeout time.Duration
	// TempDir is where OCR rasterizes pages. Defaults to the OS temp dir.
	TempDir string
	// Tesseract and PDFToPPM are the binaries to run, overridable for tests
	// and for a box that installed them somewhere unusual.
	Tesseract string
	PDFToPPM  string
	// Open opens the file for the in-process extractors; os.Open when nil.
	// attic passes one that keeps the file's last-access time and watches its
	// reads. OCR hands the path to tesseract and pdftoppm, which open it
	// themselves.
	Open func(string) (Handle, error)
}

// Handle is an open file as the extractors read it.
type Handle interface {
	io.Reader
	io.ReaderAt
	io.Closer
}

func openFile(path string) (Handle, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	return f, nil
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
	if o.Open == nil {
		o.Open = openFile
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

// extractors names what each in-process family records as its extractor.
var extractors = map[kind]string{kindText: "text", kindHTML: "html", kindZipXML: "zipxml", kindPDF: "pdf"}

// File extracts text from one file on disk. filename and mimeType come from
// whoever handed over the file, a mail client or a backup disk, so neither is
// trusted beyond choosing an extractor. mimeType may be empty.
//
// It never returns an error: every outcome is a Status, because a run over
// thousands of files must record what happened to each and continue.
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
	k := classify(filename, mimeType)
	switch {
	case k == kindNone:
		return Result{Status: StatusUnsupported}
	case k == kindImage && !o.OCR:
		return Result{Status: StatusNeedsOCR}
	}

	ctx, cancel := context.WithTimeout(ctx, o.Timeout)
	defer cancel()
	if k == kindImage {
		return run("ocr", o, func() (string, bool, error) {
			return tesseract(ctx, path, o)
		})
	}
	f, err := o.Open(path)
	if err != nil {
		// As when each reader opened the path itself: the extractor is named, and
		// a PDF whose text layer cannot be read still gets OCR.
		if k == kindPDF && o.OCR {
			return run("ocr-pdf", o, func() (string, bool, error) { return ocrPDF(ctx, path, o) })
		}
		return Result{Status: StatusFailed, Extractor: extractors[k], Err: err}
	}
	defer f.Close()
	switch k {
	case kindText:
		return run("text", o, func() (string, bool, error) { return readPlain(f, o) })
	case kindHTML:
		return run("html", o, func() (string, bool, error) { return readHTML(f, o) })
	case kindZipXML:
		return run("zipxml", o, func() (string, bool, error) { return readZipXML(f, info.Size(), o) })
	}
	return pdfResult(ctx, f, info.Size(), path, o)
}

// run calls one extractor and turns its (text, cut, error) into a Result,
// applying the character cap and the empty-versus-ok distinction in one place.
// cut says the extractor stopped at a limit of its own before the end.
func run(extractor string, o Options, f func() (string, bool, error)) Result {
	text, cut, err := f()
	if err != nil {
		return Result{Status: StatusFailed, Extractor: extractor, Err: err}
	}
	text, truncated := normalize(text, o.MaxChars)
	if text == "" {
		return Result{Status: StatusEmpty, Extractor: extractor, Truncated: cut || truncated}
	}
	return Result{Text: text, Extractor: extractor, Status: StatusOK, Truncated: truncated || cut}
}

// classify picks an extractor family from the filename first and the declared
// MIME type second. Mail clients mislabel attachments constantly, and the
// extension is what the sender's own software chose.
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

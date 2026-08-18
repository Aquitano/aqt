package extract

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/ledongthuc/pdf"
)

// pdfResult reads a PDF's text layer and, only when that comes back empty,
// considers the page images.
//
// The distinction matters more than it looks: an invoice exported from
// accounting software has a text layer and costs a millisecond, while a
// scanned contract is pixels and costs a minute of OCR. Recording which is
// which — StatusNeedsOCR — is what makes "how much would OCR actually buy me"
// a countable question instead of a guess.
func pdfResult(ctx context.Context, path string, o Options) Result {
	text, err := pdfText(path, o)
	if err == nil {
		if t := normalize(text, o.MaxChars); t != "" {
			return Result{Text: t, Extractor: "pdf", Status: StatusOK}
		}
		if !o.OCR {
			return Result{Status: StatusNeedsOCR, Extractor: "pdf"}
		}
	}
	if !o.OCR {
		// Unreadable and no OCR to fall back on. An encrypted or truncated
		// PDF is a real failure, not a document that happens to be pixels.
		if err != nil {
			return Result{Status: StatusFailed, Extractor: "pdf", Err: err}
		}
		return Result{Status: StatusNeedsOCR, Extractor: "pdf"}
	}
	return run("ocr-pdf", o, func() (string, error) { return ocrPDF(ctx, path, o) })
}

// pdfText extracts the text layer, converting the library's panics into
// errors. It panics on malformed cross-reference tables and unusual font
// encodings, which in an archive of decades of mail is a matter of when.
func pdfText(path string, o Options) (text string, err error) {
	defer func() {
		if r := recover(); r != nil {
			text, err = "", fmt.Errorf("pdf: %v", r)
		}
	}()
	f, r, err := pdf.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if r.NumPage() == 0 {
		return "", nil
	}
	plain, err := r.GetPlainText()
	if err != nil {
		return "", err
	}
	var sb strings.Builder
	if _, err := io.Copy(&sb, io.LimitReader(plain, readLimit(o))); err != nil {
		return "", err
	}
	return sb.String(), nil
}

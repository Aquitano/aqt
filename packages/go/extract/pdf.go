package extract

import (
	"context"
	"errors"
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
func pdfResult(ctx context.Context, f io.ReaderAt, size int64, path string, o Options) Result {
	text, cut, err := pdfText(ctx, f, size, o)
	if err == nil {
		if t, truncated := normalize(text, o.MaxChars); t != "" {
			return Result{Text: t, Extractor: "pdf", Status: StatusOK, Truncated: truncated || cut}
		}
		if !o.OCR {
			return Result{Status: StatusNeedsOCR, Extractor: "pdf"}
		}
	}
	if !o.OCR {
		// Unreadable (err is non-nil here) and no OCR to fall back on. An
		// encrypted or truncated PDF is a real failure, not a document that
		// happens to be pixels.
		return Result{Status: StatusFailed, Extractor: "pdf", Err: err}
	}
	return run("ocr-pdf", o, func() (string, bool, error) { return ocrPDF(ctx, path, o) })
}

// pdfPageContentLimit caps one page's decompressed content stream. A content
// stream is drawing operators — real pages run to tens of kilobytes — so only
// a decompression bomb is bigger, and it must be stopped here: the library
// materializes whatever the stream inflates to.
const pdfPageContentLimit = 8 << 20

// pdfText extracts the text layer page by page, so the caller's deadline is
// checked between pages and one oversized or broken page costs only itself.
// It reports an error only when the whole document yielded nothing, and the
// text cut when pages were left unread.
func pdfText(ctx context.Context, f io.ReaderAt, size int64, o Options) (text string, cut bool, err error) {
	// The library panics on malformed cross-reference tables and unusual font
	// encodings, which in an archive of decades of mail is a matter of when.
	defer func() {
		if r := recover(); r != nil {
			text, cut, err = "", false, fmt.Errorf("pdf: %v", r)
		}
	}()
	r, err := pdf.NewReader(f, size)
	if err != nil {
		return "", false, err
	}

	var sb strings.Builder
	var lastErr error
	read := 0
	max := readLimit(o)
	page := 1
	for ; page <= r.NumPage() && int64(sb.Len()) < max; page++ {
		if err := ctx.Err(); err != nil {
			// Out of time with pages read: those pages are kept as cut text. A
			// cancelled run keeps nothing.
			if errors.Is(err, context.DeadlineExceeded) && read > 0 {
				return sb.String(), true, nil
			}
			return "", false, err
		}
		t, err := pdfPageText(r.Page(page))
		if err != nil {
			lastErr = err
			continue
		}
		sb.WriteString(t)
		read++
	}
	if read == 0 && lastErr != nil {
		return "", false, lastErr
	}
	return sb.String(), page <= r.NumPage(), nil
}

// pdfPageText reads one page's text layer, refusing pages whose decompressed
// content is over the bomb limit and containing the library's panics to the
// page that caused them.
func pdfPageText(p pdf.Page) (text string, err error) {
	defer func() {
		if r := recover(); r != nil {
			text, err = "", fmt.Errorf("pdf: %v", r)
		}
	}()
	over, err := contentOversized(p, pdfPageContentLimit)
	if err != nil {
		return "", err
	}
	if over {
		return "", fmt.Errorf("pdf: page content stream inflates past %d bytes", pdfPageContentLimit)
	}
	return p.GetPlainText(nil)
}

// contentOversized decompresses at most limit+1 bytes of a page's content
// stream(s) to learn whether handing the page to the parser would be safe.
// The pre-flight costs one extra capped decompression, which is nothing next
// to what an unchecked bomb costs.
func contentOversized(p pdf.Page, limit int64) (bool, error) {
	strm := p.V.Key("Contents")
	if strm.Kind() == pdf.Null {
		return false, nil
	}
	streams := []pdf.Value{strm}
	if strm.Kind() == pdf.Array {
		streams = streams[:0]
		for i := 0; i < strm.Len(); i++ {
			streams = append(streams, strm.Index(i))
		}
	}
	remaining := limit
	for _, s := range streams {
		n, err := io.Copy(io.Discard, io.LimitReader(s.Reader(), remaining+1))
		if err != nil {
			return false, fmt.Errorf("pdf: read content stream: %w", err)
		}
		remaining -= n
		if remaining < 0 {
			return true, nil
		}
	}
	return false, nil
}

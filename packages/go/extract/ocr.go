package extract

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// OCR is a subprocess rather than a linked library on purpose: tesseract
// through cgo would put libtesseract, libleptonica and a libc in whatever
// links it. As a subprocess it is an optional capability — present on PATH it
// is used, absent the files are recorded as needing it and nothing else
// changes. apps/bank/DESIGN.md has where that matters for bank.

// OCRAvailable reports whether the external tools exist, so a run can refuse
// up front instead of recording thousands of identical failures.
func OCRAvailable(o Options) error {
	o = o.withDefaults()
	if _, err := exec.LookPath(o.Tesseract); err != nil {
		return fmt.Errorf("%s not found on PATH: OCR needs tesseract installed", o.Tesseract)
	}
	if _, err := exec.LookPath(o.PDFToPPM); err != nil {
		return fmt.Errorf("%s not found on PATH: OCR of PDFs needs poppler-utils", o.PDFToPPM)
	}
	return nil
}

// ocrPDF rasterizes pages and reads each one. A PDF is not something
// tesseract accepts, and a scanned document is one image per page. One page past
// OCRMaxPages is rasterized and not read, so the text counts as cut only when
// the document really goes on.
func ocrPDF(ctx context.Context, path string, o Options) (string, bool, error) {
	dir, err := os.MkdirTemp(o.TempDir, "ocr-")
	if err != nil {
		return "", false, err
	}
	defer os.RemoveAll(dir)

	prefix := filepath.Join(dir, "page")
	// 300 dpi is tesseract's documented sweet spot: below it accuracy drops
	// sharply, above it costs time for nothing.
	cmd := exec.CommandContext(ctx, o.PDFToPPM, "-r", "300", "-png",
		"-f", "1", "-l", strconv.Itoa(o.OCRMaxPages+1), path, prefix)
	stderr := ocrBuffer{left: 8192}
	cmd.Stderr = &stderr
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Run(); err != nil {
		return "", false, fmt.Errorf("%s: %w: %s", o.PDFToPPM, err, strings.TrimSpace(stderr.String()))
	}

	pages, err := filepath.Glob(prefix + "*.png")
	if err != nil {
		return "", false, err
	}
	sort.Strings(pages)
	if len(pages) == 0 {
		return "", false, nil
	}
	cut := false
	if o.OCRMaxPages > 0 && len(pages) > o.OCRMaxPages {
		cut, pages = true, pages[:o.OCRMaxPages]
	}

	var sb strings.Builder
	var lastErr error
	read := 0
	for _, p := range pages {
		text, pageCut, err := tesseract(ctx, p, o)
		if err != nil {
			if ctx.Err() != nil {
				// A timeout mid-document is not "that was all the text":
				// storing the partial result as ok would end retries forever.
				return "", false, err
			}
			// One unreadable page should not lose the other thirty.
			lastErr = err
			cut = true
			continue
		}
		cut = cut || pageCut
		read++
		sb.WriteString(text)
		sb.WriteByte('\n')
		if sb.Len() > o.MaxChars {
			cut = true
			break
		}
	}
	if read == 0 {
		// Every page failed; "empty document" would be a lie and, as a
		// terminal status, would never be retried.
		return "", false, lastErr
	}
	return sb.String(), cut, nil
}

func tesseract(ctx context.Context, path string, o Options) (string, bool, error) {
	cmd := exec.CommandContext(ctx, o.Tesseract, path, "stdout", "-l", o.OCRLang)
	stdout := ocrBuffer{left: 4 * max(o.MaxChars+1, 1)}
	stderr := ocrBuffer{left: 8192}
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Run(); err != nil {
		return "", false, fmt.Errorf("%s: %w: %s", o.Tesseract, err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), stdout.cut, nil
}

// Keep a bounded prefix even when a tool ignores the document limits. Four
// bytes per retained rune leaves File enough text to detect truncation.
type ocrBuffer struct {
	buf  bytes.Buffer
	left int
	cut  bool
}

func (b *ocrBuffer) Write(p []byte) (int, error) {
	n := min(len(p), b.left)
	b.cut = b.cut || n < len(p)
	_, _ = b.buf.Write(p[:n])
	b.left -= n
	return len(p), nil
}
func (b *ocrBuffer) String() string { return b.buf.String() }

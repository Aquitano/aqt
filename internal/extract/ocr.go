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
)

// OCR is a subprocess rather than a linked library on purpose: tesseract
// through cgo would put libtesseract, libleptonica and a libc in whatever
// links it. As a subprocess it is an optional capability — present on PATH it
// is used, absent the blobs are recorded as needing it and nothing else
// changes. See DESIGN.md for where that matters.

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
// tesseract accepts, and a scanned document is one image per page.
func ocrPDF(ctx context.Context, path string, o Options) (string, error) {
	dir, err := os.MkdirTemp(o.TempDir, "ocr-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)

	prefix := filepath.Join(dir, "page")
	// 300 dpi is tesseract's documented sweet spot: below it accuracy drops
	// sharply, above it costs time for nothing.
	cmd := exec.CommandContext(ctx, o.PDFToPPM, "-r", "300", "-png",
		"-f", "1", "-l", strconv.Itoa(o.OCRMaxPages), path, prefix)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%s: %w: %s", o.PDFToPPM, err, strings.TrimSpace(stderr.String()))
	}

	pages, err := filepath.Glob(prefix + "*.png")
	if err != nil {
		return "", err
	}
	sort.Strings(pages)
	if len(pages) == 0 {
		return "", nil
	}

	var sb strings.Builder
	for _, p := range pages {
		text, err := tesseract(ctx, p, o)
		if err != nil {
			// One unreadable page should not lose the other thirty.
			continue
		}
		sb.WriteString(text)
		sb.WriteByte('\n')
		if sb.Len() > o.MaxChars {
			break
		}
	}
	return sb.String(), nil
}

func tesseract(ctx context.Context, path string, o Options) (string, error) {
	cmd := exec.CommandContext(ctx, o.Tesseract, path, "stdout", "-l", o.OCRLang)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%s: %w: %s", o.Tesseract, err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

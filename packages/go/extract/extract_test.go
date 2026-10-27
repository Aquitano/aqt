package extract

import (
	"archive/zip"
	"bytes"
	"compress/zlib"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func write(t *testing.T, name string, content []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestClassify(t *testing.T) {
	cases := []struct {
		filename, mime string
		want           kind
	}{
		{"notes.txt", "text/plain", kindText},
		{"page.html", "text/html", kindHTML},
		{"report.docx", "", kindZipXML},
		{"invoice.pdf", "", kindPDF},
		{"scan.JPG", "", kindImage},
		{"movie.mkv", "video/x-matroska", kindNone},
		// The extension wins: mail clients label attachments
		// application/octet-stream constantly.
		{"contract.pdf", "application/octet-stream", kindPDF},
		// With no usable extension the declared type is all there is.
		{"attachment", "application/pdf", kindPDF},
		{"", "image/png", kindImage},
		// A malformed Content-Type still has a recognisable prefix.
		{"noext", "text/plain; charset=", kindText},
	}
	for _, c := range cases {
		if got := classify(c.filename, c.mime); got != c.want {
			t.Errorf("classify(%q, %q) = %v, want %v", c.filename, c.mime, got, c.want)
		}
	}
}

func TestPDFFallback(t *testing.T) {
	tool := fakeBin(t, "pdftotext", `printf 'recovered text'`)
	path := write(t, "broken.pdf", []byte("not a PDF"))
	res := File(t.Context(), path, "broken.pdf", "", Options{PDFToText: tool, MaxChars: 9})
	if res.Status != StatusOK || res.Text != "recovered" || !res.Truncated {
		t.Fatalf("fallback: %+v", res)
	}
	res = File(t.Context(), path, "broken.pdf", "", Options{PDFToText: filepath.Join(t.TempDir(), "missing")})
	if res.Status != StatusFailed || res.Err == nil {
		t.Fatalf("missing fallback: %+v", res)
	}
}

func TestNormalize(t *testing.T) {
	cases := []struct{ in, want string }{
		{"  hello   world \n\n next ", "hello world next"},
		{"tabs\tand\rreturns", "tabs and returns"},
		{"nul\x00byte", "nulbyte"},
		{"\xff\xfe invalid utf8", "invalid utf8"},
	}
	for _, c := range cases {
		if got, _ := normalize(c.in, 1000); got != c.want {
			t.Errorf("normalize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestNormalizeTruncatesOnRuneBoundary(t *testing.T) {
	got, cut := normalize(strings.Repeat("é", 100), 11)
	if len(got) > 11 || !cut {
		t.Fatalf("got %d bytes, cut %v; want at most 11 and cut", len(got), cut)
	}
	if _, cut := normalize("é é é   ", 11); cut {
		t.Error("text that fits, trailing spaces aside, was reported cut")
	}
	if strings.ContainsRune(got, '�') || !isValidUTF8(got) {
		t.Fatalf("truncation split a rune: %q", got)
	}
}

func isValidUTF8(s string) bool {
	for _, r := range s {
		if r == '�' {
			return false
		}
	}
	return true
}

func TestFilePlainText(t *testing.T) {
	path := write(t, "notes.txt", []byte("the invoice   total is\n\n  4200 EUR"))
	res := File(context.Background(), path, "notes.txt", "text/plain", Options{})
	if res.Status != StatusOK {
		t.Fatalf("status = %v (%v)", res.Status, res.Err)
	}
	if res.Text != "the invoice total is 4200 EUR" {
		t.Fatalf("text = %q", res.Text)
	}
}

// attic reads backup disks through an opener that keeps last-access times, so
// the in-process extractors must not open the path themselves.
func TestFileReadsThroughTheGivenOpener(t *testing.T) {
	path := write(t, "notes.txt", []byte("through the opener"))
	opened := 0
	o := Options{Open: func(p string) (Handle, error) {
		opened++
		return openFile(p)
	}}
	if res := File(context.Background(), path, "notes.txt", "", o); res.Status != StatusOK || opened != 1 {
		t.Fatalf("status %s, opened %d times; want ok, opened once through the opener", res.Status, opened)
	}
}

func TestFileHTMLStripsMarkup(t *testing.T) {
	path := write(t, "page.html", []byte("<html><style>p{color:red}</style><p>Hello <b>Alice</b></p></html>"))
	res := File(context.Background(), path, "page.html", "text/html", Options{})
	if res.Status != StatusOK {
		t.Fatalf("status = %v (%v)", res.Status, res.Err)
	}
	if strings.Contains(res.Text, "<") || strings.Contains(res.Text, "color:red") {
		t.Fatalf("markup survived: %q", res.Text)
	}
	if !strings.Contains(res.Text, "Hello") || !strings.Contains(res.Text, "Alice") {
		t.Fatalf("text lost: %q", res.Text)
	}
}

// docx builds the smallest thing that is genuinely a Word document as far as
// the extractor is concerned: a zip with word/document.xml in it.
func docx(t *testing.T, name string, parts map[string]string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	zw := zip.NewWriter(f)
	for name, content := range parts {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestFileOOXML(t *testing.T) {
	path := docx(t, "report.docx", map[string]string{
		"word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>` +
			`<w:p><w:r><w:t>Quarterly</w:t></w:r><w:r><w:t>revenue</w:t></w:r></w:p></w:body></w:document>`,
		// Styles must not reach the index: their vocabulary would match
		// everything.
		"word/styles.xml": `<?xml version="1.0"?><styles><name val="Heading1"/></styles>`,
	})
	res := File(context.Background(), path, "report.docx", "", Options{})
	if res.Status != StatusOK {
		t.Fatalf("status = %v (%v)", res.Status, res.Err)
	}
	if !strings.Contains(res.Text, "Quarterly") || !strings.Contains(res.Text, "revenue") {
		t.Fatalf("text = %q", res.Text)
	}
	if strings.Contains(res.Text, "Heading1") {
		t.Fatalf("styles reached the index: %q", res.Text)
	}
}

func TestFileUnsupportedAndTooBig(t *testing.T) {
	path := write(t, "clip.mkv", []byte("binary"))
	if res := File(context.Background(), path, "clip.mkv", "video/x-matroska", Options{}); res.Status != StatusUnsupported {
		t.Fatalf("status = %v, want unsupported", res.Status)
	}
	big := write(t, "big.txt", []byte("plenty of text here"))
	if res := File(context.Background(), big, "big.txt", "text/plain", Options{MaxBytes: 4}); res.Status != StatusTooBig {
		t.Fatalf("status = %v, want too_big", res.Status)
	}
}

func TestFileEmptyIsNotAFailure(t *testing.T) {
	path := write(t, "blank.txt", nil)
	if res := File(context.Background(), path, "blank.txt", "text/plain", Options{}); res.Status != StatusEmpty {
		t.Fatalf("status = %v, want empty", res.Status)
	}
}

// An image with OCR off is the queue for a later pass, not a failure: getting
// this wrong would either hide the work or make it look broken.
func TestImageNeedsOCRWhenDisabled(t *testing.T) {
	path := write(t, "scan.png", []byte("\x89PNG not really"))
	res := File(context.Background(), path, "scan.png", "image/png", Options{})
	if res.Status != StatusNeedsOCR {
		t.Fatalf("status = %v, want needs_ocr", res.Status)
	}
	if res.Text != "" {
		t.Fatalf("text = %q, want empty", res.Text)
	}
}

func TestCorruptPDFDoesNotPanic(t *testing.T) {
	path := write(t, "broken.pdf", []byte("%PDF-1.4 and then nonsense"))
	res := File(context.Background(), path, "broken.pdf", "application/pdf", Options{})
	if res.Status != StatusFailed {
		t.Fatalf("status = %v, want failed", res.Status)
	}
}

// onePagePDF builds a minimal valid PDF whose single page carries content as
// its FlateDecode content stream.
func onePagePDF(t *testing.T, content []byte) []byte {
	t.Helper()
	return pagePDF(t, content, 612, 792)
}

func pagePDF(t *testing.T, content []byte, width, height int) []byte {
	t.Helper()
	var z bytes.Buffer
	zw := zlib.NewWriter(&z)
	if _, err := zw.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	var offsets []int
	obj := func(body string) {
		offsets = append(offsets, buf.Len())
		fmt.Fprintf(&buf, "%d 0 obj\n%s\nendobj\n", len(offsets), body)
	}
	buf.WriteString("%PDF-1.4\n")
	obj("<< /Type /Catalog /Pages 2 0 R >>")
	obj("<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
	obj(fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Contents 4 0 R /Resources << >> >>", width, height))
	offsets = append(offsets, buf.Len())
	fmt.Fprintf(&buf, "4 0 obj\n<< /Length %d /Filter /FlateDecode >>\nstream\n", z.Len())
	buf.Write(z.Bytes())
	buf.WriteString("\nendstream\nendobj\n")
	xref := buf.Len()
	fmt.Fprintf(&buf, "xref\n0 %d\n0000000000 65535 f \n", len(offsets)+1)
	for _, off := range offsets {
		fmt.Fprintf(&buf, "%010d 00000 n \n", off)
	}
	fmt.Fprintf(&buf, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets)+1, xref)
	return buf.Bytes()
}

// A tiny compressed stream can inflate to gigabytes; the parser materializes
// whatever it inflates to, so the bomb must be refused before the parser.
func TestPDFDecompressionBombIsBounded(t *testing.T) {
	bomb := bytes.Repeat([]byte("q Q "), (pdfPageContentLimit+(4<<20))/4)
	path := write(t, "bomb.pdf", onePagePDF(t, bomb))
	res := File(context.Background(), path, "bomb.pdf", "application/pdf", Options{})
	if res.Status != StatusFailed {
		t.Fatalf("status = %v, want failed", res.Status)
	}
	if res.Err == nil || !strings.Contains(res.Err.Error(), "inflates past") {
		t.Fatalf("err = %v, want the bomb named", res.Err)
	}
	// The same document under the limit parses normally.
	small := write(t, "small.pdf", onePagePDF(t, []byte("q Q")))
	if res := File(context.Background(), small, "small.pdf", "application/pdf", Options{}); res.Status != StatusNeedsOCR {
		t.Fatalf("status = %v, want needs_ocr for a textless page", res.Status)
	}
}

// Options.Timeout used to never reach the text-layer path at all; the page
// loop must notice a dead context.
func TestPDFTextHonorsContext(t *testing.T) {
	doc := onePagePDF(t, []byte("q Q"))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := pdfText(ctx, bytes.NewReader(doc), int64(len(doc)), DefaultOptions()); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

// fakeBin writes a script standing in for an external tool, so the OCR path is
// tested without installing tesseract.
func fakeBin(t *testing.T, name, body string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell script stand-ins are POSIX only")
	}
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestOCRImage(t *testing.T) {
	tess := fakeBin(t, "tesseract", `echo "SCANNED  invoice 4200"`)
	path := write(t, "scan.png", []byte("pretend pixels"))
	res := File(context.Background(), path, "scan.png", "image/png", Options{OCR: true, Tesseract: tess})
	if res.Status != StatusOK {
		t.Fatalf("status = %v (%v)", res.Status, res.Err)
	}
	if res.Text != "SCANNED invoice 4200" {
		t.Fatalf("text = %q", res.Text)
	}
	if res.Extractor != "ocr" {
		t.Fatalf("extractor = %q", res.Extractor)
	}
}

func TestOCRFailureIsRecordedNotPanicked(t *testing.T) {
	tess := fakeBin(t, "tesseract", `echo "boom" >&2; exit 1`)
	path := write(t, "scan.png", []byte("pretend pixels"))
	res := File(context.Background(), path, "scan.png", "image/png", Options{OCR: true, Tesseract: tess})
	if res.Status != StatusFailed {
		t.Fatalf("status = %v, want failed", res.Status)
	}
	if res.Err == nil || !strings.Contains(res.Err.Error(), "boom") {
		t.Fatalf("err = %v, want the tool's own message", res.Err)
	}
}

// A scan whose every page fails OCR must fail, not store as an empty document
// — empty is a terminal status the queue never retries.
func TestOCRPDFAllPagesFailedIsAnError(t *testing.T) {
	ppm := fakeBin(t, "pdftoppm", `for a in "$@"; do prefix="$a"; done; touch "$prefix-1.png" "$prefix-2.png"`)
	tess := fakeBin(t, "tesseract", `echo "unreadable page" >&2; exit 1`)
	_, _, err := ocrPDF(context.Background(), write(t, "scan.pdf", []byte("%PDF")),
		Options{PDFToPPM: ppm, Tesseract: tess, MaxChars: 1 << 20})
	if err == nil || !strings.Contains(err.Error(), "unreadable page") {
		t.Fatalf("err = %v, want the page failure surfaced", err)
	}
}

// A timeout mid-document must fail the document even though earlier pages
// read fine: partial text stored as ok would freeze a twenty-page scan at
// page two forever.
func TestOCRPDFTimeoutIsAnError(t *testing.T) {
	ppm := fakeBin(t, "pdftoppm", `for a in "$@"; do prefix="$a"; done; touch "$prefix-1.png" "$prefix-2.png"`)
	// The first call answers instantly; the second outlives the deadline.
	tess := fakeBin(t, "tesseract", `m="$(dirname "$0")/ran"; if [ -e "$m" ]; then sleep 5 >/dev/null 2>&1; fi; touch "$m"; echo "page text"`)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_, _, err := ocrPDF(ctx, write(t, "scan.pdf", []byte("%PDF")),
		Options{PDFToPPM: ppm, Tesseract: tess, MaxChars: 1 << 20})
	if err == nil {
		t.Fatal("a timeout mid-scan must fail the document, not store what it got")
	}
}

func TestOCRAvailableReportsMissingTools(t *testing.T) {
	err := OCRAvailable(Options{Tesseract: "definitely-not-installed-xyz"})
	if err == nil || !strings.Contains(err.Error(), "tesseract") {
		t.Fatalf("err = %v, want a message naming tesseract", err)
	}
}

// Old Windows tools write text in Windows-1252 or UTF-16; both must come out
// searchable, umlauts included.
func TestFileDecodesLegacyText(t *testing.T) {
	cases := []struct {
		name    string
		content []byte
		want    string
	}{
		{"cp1252.txt", []byte("Vertr\xe4ge f\xfcr Stra\xdfe"), "Verträge für Straße"},
		{"utf16.txt", []byte{0xFF, 0xFE, 'V', 0, 'e', 0, 'r', 0, 't', 0, 'r', 0, 0xE4, 0, 'g', 0, 'e', 0}, "Verträge"},
		// One stray byte must not turn the rest of a UTF-8 file into mojibake.
		{"mixed.csv", []byte("Grüße aus München \x96 Café"), "Grüße aus München – Café"},
		{"bom.txt", []byte("\xef\xbb\xbfVerträge"), "Verträge"},
		{"hex.txt", []byte("FEFF0041 is a code point"), "FEFF0041 is a code point"},
	}
	for _, tc := range cases {
		res := File(context.Background(), write(t, tc.name, tc.content), tc.name, "", Options{})
		if res.Text != tc.want {
			t.Errorf("%s: %q, want %q", tc.name, res.Text, tc.want)
		}
	}
}

// A reader that stops at its own read budget has cut the document as surely
// as the character cap.
func TestFileMarksTextCutByTheReadBudget(t *testing.T) {
	page := "<p>start</p>" + strings.Repeat("<br>", 400_000) + "<p>end</p>"
	path := write(t, "page.html", []byte(page))
	res := File(context.Background(), path, "page.html", "", Options{MaxChars: 1000})
	if res.Status != StatusOK || !res.Truncated || strings.Contains(res.Text, "end") {
		t.Errorf("status %s, truncated %v, text %q; want ok, truncated, without the end", res.Status, res.Truncated, res.Text)
	}
}

// OCR rasterizes one page past the cap, so only a document that goes on is
// reported cut.
func TestOCRPageCapMarksOnlyLongerDocumentsCut(t *testing.T) {
	tess := fakeBin(t, "tesseract", `echo "page text"`)
	for pages, want := range map[int]bool{2: false, 3: true} {
		ppm := fakeBin(t, "pdftoppm", fmt.Sprintf(`for a in "$@"; do prefix="$a"; done; for i in $(seq 1 %d); do touch "$prefix-$i.png"; done`, pages))
		text, cut, err := ocrPDF(context.Background(), write(t, "scan.pdf", []byte("%PDF")),
			Options{Tesseract: tess, PDFToPPM: ppm, OCRMaxPages: 2, MaxChars: 1 << 20})
		if err != nil || cut != want || strings.Count(text, "page text") != 2 {
			t.Errorf("%d pages: cut %v, %d pages read, %v; want cut %v and 2 read", pages, cut, strings.Count(text, "page text"), err, want)
		}
	}
}

// A file that cannot be opened still names the extractor it was meant for.
func TestFileOpenFailureNamesTheExtractor(t *testing.T) {
	path := write(t, "notes.txt", []byte("unreachable"))
	o := Options{Open: func(string) (Handle, error) { return nil, os.ErrPermission }}
	if res := File(context.Background(), path, "notes.txt", "", o); res.Status != StatusFailed || res.Extractor != "text" {
		t.Errorf("status %s, extractor %q; want failed from text", res.Status, res.Extractor)
	}
}

func TestOCROutputLimitsAndPartialPages(t *testing.T) {
	tess := fakeBin(t, "tesseract", `head -c 100000 /dev/zero | tr '\000' 'a'; head -c 100000 /dev/zero | tr '\000' 'e' >&2`)
	res := File(t.Context(), write(t, "scan.png", []byte("pixels")), "scan.png", "image/png", Options{OCR: true, Tesseract: tess, MaxChars: 32})
	if res.Status != StatusOK || !res.Truncated || len(res.Text) != 32 {
		t.Fatalf("bounded output: %+v", res)
	}
	ppm := fakeBin(t, "pdftoppm", `for a in "$@"; do prefix="$a"; done; touch "$prefix-1.png" "$prefix-2.png"`)
	tess = fakeBin(t, "tesseract", `case "$1" in *-2.png) exit 1;; esac; echo 'first page'`)
	text, cut, err := ocrPDF(t.Context(), write(t, "scan.pdf", []byte("%PDF")), Options{PDFToPPM: ppm, Tesseract: tess, MaxChars: 1024})
	if err != nil || !cut || !strings.Contains(text, "first page") {
		t.Fatalf("partial pages: %q %v %v", text, cut, err)
	}
}

func TestOCRDoesNotUpscaleSmallPDFPages(t *testing.T) {
	ppm, err := exec.LookPath("pdftoppm")
	if err != nil {
		t.Skip("Poppler is not installed")
	}
	tess := fakeBin(t, "tesseract", `od -An -tu4 --endian=big -j16 -N4 "$1"`)
	pdf := write(t, "small.pdf", pagePDF(t, []byte("q Q"), 72, 72))
	text, cut, err := ocrPDF(t.Context(), pdf, Options{Tesseract: tess, PDFToPPM: ppm, OCRMaxPages: 1, MaxChars: 1024})
	if err != nil || cut || strings.TrimSpace(text) != "300" {
		t.Fatalf("one inch at 300 dpi: %q cut=%v err=%v", text, cut, err)
	}
}

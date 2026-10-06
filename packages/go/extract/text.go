package extract

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"html"
	"io"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
	xunicode "golang.org/x/text/encoding/unicode"
)

// readLimit bounds what any extractor pulls off disk. MaxChars caps what is
// stored; this caps what is read, so a zip bomb or a pathological XML part
// cannot be decompressed into memory in full.
func readLimit(o Options) int64 { return int64(o.MaxChars)*4 + 1<<20 }

// readCapped reads up to readLimit bytes and reports whether more followed.
func readCapped(r io.Reader, o Options) ([]byte, bool, error) {
	limit := readLimit(o)
	b, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(b)) > limit {
		return b[:limit], true, nil
	}
	return b, false, nil
}

func readPlain(r io.Reader, o Options) (string, bool, error) {
	b, cut, err := readCapped(r, o)
	return decodeText(b, cut), cut, err
}

func readHTML(r io.Reader, o Options) (string, bool, error) {
	b, cut, err := readCapped(r, o)
	return StripHTML(decodeText(b, cut)), cut, err
}

// decodeText turns a file's bytes into text: UTF-16 behind a byte-order mark,
// otherwise UTF-8, with each byte that is not UTF-8 read as Windows-1252, which
// old Windows tools wrote, German Excel's CSV export among them. cut says the
// read stopped at a limit, which may have split the last character.
func decodeText(b []byte, cut bool) string {
	if bytes.HasPrefix(b, []byte{0xFF, 0xFE}) || bytes.HasPrefix(b, []byte{0xFE, 0xFF}) {
		if s, err := xunicode.UTF16(xunicode.LittleEndian, xunicode.UseBOM).NewDecoder().Bytes(b); err == nil {
			return string(s)
		}
	}
	b = bytes.TrimPrefix(b, []byte("\xef\xbb\xbf"))
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	sb.Grow(len(b))
	for len(b) > 0 {
		r, size := utf8.DecodeRune(b)
		if r == utf8.RuneError && size == 1 {
			if cut && !utf8.FullRune(b) {
				break
			}
			r = charmap.Windows1252.DecodeByte(b[0])
		}
		sb.WriteRune(r)
		b = b[size:]
	}
	return sb.String()
}

var (
	htmlStripBlocks = regexp.MustCompile(`(?is)<(style|script|head)\b.*?</\s*(style|script|head)\s*>`)
	htmlBreaks      = regexp.MustCompile(`(?i)<\s*(br|/p|/div|/tr|/li|/h[1-6])\s*/?\s*>`)
	htmlTags        = regexp.MustCompile(`(?s)<[^>]*>`)
	blankLines      = regexp.MustCompile(`\n{3,}`)
)

// StripHTML reduces an HTML body to searchable plain text.
func StripHTML(s string) string {
	s = htmlStripBlocks.ReplaceAllString(s, "")
	s = htmlBreaks.ReplaceAllString(s, "\n")
	s = htmlTags.ReplaceAllString(s, "")
	s = html.UnescapeString(s)
	var lines []string
	for _, l := range strings.Split(s, "\n") {
		lines = append(lines, strings.TrimSpace(l))
	}
	s = strings.Join(lines, "\n")
	return strings.TrimSpace(blankLines.ReplaceAllString(s, "\n\n"))
}

// zipXMLParts names the parts worth reading per format. Everything else in an
// OOXML or OpenDocument package is styles, themes, relationships and embedded
// media — noise that would swamp the index with markup vocabulary.
func zipXMLParts(name string) bool {
	switch {
	case name == "word/document.xml", // docx
		strings.HasPrefix(name, "word/header"),
		strings.HasPrefix(name, "word/footer"),
		name == "xl/sharedStrings.xml", // xlsx: most cell text lives here
		strings.HasPrefix(name, "xl/worksheets/sheet"),
		strings.HasPrefix(name, "ppt/slides/slide"),
		strings.HasPrefix(name, "ppt/notesSlides/notesSlide"),
		name == "content.xml", // OpenDocument
		name == "meta.xml":
		return strings.HasSuffix(name, ".xml")
	}
	return false
}

// readZipXML pulls the character data out of a zip-of-XML document. It reads
// text, not structure: for search, "what words are in this file" is the whole
// question, and every one of these formats buries those words under a
// different schema.
// It reports the text cut when the read budget ran out.
func readZipXML(r io.ReaderAt, size int64, o Options) (string, bool, error) {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return "", false, err
	}

	// Excel writes the sheets before the shared strings, where a workbook's
	// words are; the sheets' numbers must not spend the budget first.
	files := slices.Clone(zr.File)
	if i := slices.IndexFunc(files, func(f *zip.File) bool { return f.Name == "xl/sharedStrings.xml" }); i > 0 {
		shared := files[i]
		files = append([]*zip.File{shared}, slices.Delete(files, i, i+1)...)
	}
	var sb strings.Builder
	budget := readLimit(o)
	for _, f := range files {
		if budget <= 0 {
			break
		}
		if !zipXMLParts(f.Name) {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			continue
		}
		n, err := appendXMLText(&sb, io.LimitReader(rc, budget))
		rc.Close()
		budget -= n
		if err != nil {
			continue
		}
	}
	return sb.String(), budget <= 0, nil
}

// appendXMLText writes every character-data node into sb, separated by
// spaces, and reports how many bytes it consumed. A malformed tail is not an
// error: half a document's text is worth more than none.
func appendXMLText(sb *strings.Builder, r io.Reader) (int64, error) {
	counting := &countingReader{r: r}
	dec := xml.NewDecoder(counting)
	// Office documents reference entities the decoder does not know; without
	// this a single &nbsp; aborts the parse.
	dec.Strict = false
	dec.AutoClose = xml.HTMLAutoClose
	dec.Entity = xml.HTMLEntity
	for {
		tok, err := dec.Token()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return counting.n, nil
			}
			return counting.n, err
		}
		if cd, ok := tok.(xml.CharData); ok {
			if s := strings.TrimSpace(string(cd)); s != "" {
				sb.WriteString(s)
				sb.WriteByte(' ')
			}
		}
	}
}

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// normalize makes extracted text safe to store and cheap to index: valid
// UTF-8, no control characters, no runs of whitespace, and bounded length.
// Extractors produce all three problems — OCR emits stray control bytes, PDF
// text layers emit per-glyph spacing, XML emits indentation. It reports
// whether text was cut at maxChars.
func normalize(s string, maxChars int) (string, bool) {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, " ")
	}
	var sb strings.Builder
	sb.Grow(len(s))
	space := true // leading whitespace is dropped
	cut := false
	for i, r := range s {
		switch {
		case r == '\n' || r == '\t' || unicode.IsSpace(r):
			if !space {
				sb.WriteByte(' ')
				space = true
			}
		case r == 0 || unicode.IsControl(r):
			// dropped: never useful, and NUL cannot go in a text column
		default:
			sb.WriteRune(r)
			space = false
		}
		if sb.Len() >= maxChars {
			cut = strings.IndexFunc(s[i+utf8.RuneLen(r):], kept) >= 0
			break
		}
	}
	out := strings.TrimSpace(sb.String())
	if len(out) > maxChars {
		out = strings.TrimSpace(truncateRunes(out, maxChars))
		cut = true
	}
	return out, cut
}

// truncateRunes cuts on a rune boundary, so the stored text never ends in half
// a multi-byte character.
func truncateRunes(s string, max int) string {
	if len(s) <= max {
		return s
	}
	for max > 0 && !utf8.RuneStart(s[max]) {
		max--
	}
	return s[:max]
}

// kept reports whether normalize writes r rather than dropping it or folding
// it into a space.
func kept(r rune) bool { return !unicode.IsSpace(r) && !unicode.IsControl(r) }

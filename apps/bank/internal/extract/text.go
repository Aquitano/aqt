package extract

import (
	"archive/zip"
	"encoding/xml"
	"errors"
	"io"
	"os"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/aquitano/aqt/apps/bank/internal/eml"
)

// readLimit bounds what any extractor pulls off disk. MaxChars caps what is
// stored; this caps what is read, so a zip bomb or a pathological XML part
// cannot be decompressed into memory in full.
func readLimit(o Options) int64 { return int64(o.MaxChars)*4 + 1<<20 }

func readPlain(path string, o Options) (string, error) {
	b, err := readCapped(path, readLimit(o))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func readHTML(path string, o Options) (string, error) {
	b, err := readCapped(path, readLimit(o))
	if err != nil {
		return "", err
	}
	return eml.StripHTML(string(b)), nil
}

func readCapped(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, limit))
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
func readZipXML(path string, o Options) (string, error) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return "", err
	}
	defer zr.Close()

	var sb strings.Builder
	budget := readLimit(o)
	for _, f := range zr.File {
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
	return sb.String(), nil
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
// text layers emit per-glyph spacing, XML emits indentation.
func normalize(s string, maxChars int) string {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, " ")
	}
	var sb strings.Builder
	sb.Grow(len(s))
	space := true // leading whitespace is dropped
	for _, r := range s {
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
			break
		}
	}
	out := strings.TrimSpace(sb.String())
	if len(out) > maxChars {
		out = strings.TrimSpace(truncateRunes(out, maxChars))
	}
	return out
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

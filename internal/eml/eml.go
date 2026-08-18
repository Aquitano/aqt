// Package eml parses RFC 822/MIME email and ingests it into the archive.
// It is shared by the Gmail sync (format=raw), ProtonMail exports (.eml) and
// Gmail Takeout (.mbox).
package eml

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"html"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"regexp"
	"strings"
	"time"

	"golang.org/x/text/encoding/htmlindex"
)

type Attachment struct {
	Filename string
	MimeType string
	Data     []byte
}

type Message struct {
	MessageID   string
	From        string
	To          []string
	Cc          []string
	Subject     string
	Date        time.Time
	Body        string
	Attachments []Attachment
	// Warnings names structure the parser could not read as written — a
	// malformed Content-Type, a multipart part with no usable boundary.
	// Importers surface these so damaged mail is visible instead of quietly
	// arriving with a body full of MIME syntax.
	Warnings []string
}

var wordDecoder = &mime.WordDecoder{CharsetReader: charsetReader}

// Parse decodes one raw email. It never fails on malformed bodies — the worst
// case is an empty Body — so a single broken message can't abort an import.
func Parse(raw []byte) (*Message, error) {
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	h := msg.Header

	out := &Message{
		MessageID: strings.Trim(h.Get("Message-Id"), "<> \t"),
		From:      decodeHeader(h.Get("From")),
		To:        addressList(h.Get("To")),
		Cc:        addressList(h.Get("Cc")),
		Subject:   decodeHeader(h.Get("Subject")),
	}
	if d, err := mail.ParseDate(h.Get("Date")); err == nil {
		out.Date = d
	}

	p := &parser{out: out}
	p.walk(h.Get("Content-Type"), h.Get("Content-Transfer-Encoding"), h.Get("Content-Disposition"), msg.Body, 0, false)
	out.Body = p.body()
	return out, nil
}

// parser collects body candidates while walking the MIME tree.
type parser struct {
	out   *Message
	plain []string
	html  []string
	// named holds text parts carrying only a name= parameter and no
	// disposition. A name alone does not make a part an attachment (mailers
	// put one on the sole body part), so these are kept as attachments but
	// stay available as a last-resort body.
	named []namedText
}

type namedText struct {
	text   string
	isHTML bool
}

func (p *parser) walk(contentType, transferEncoding, disposition string, r io.Reader, depth int, inAlternative bool) {
	if depth > 10 {
		return
	}
	if contentType == "" {
		contentType = "text/plain; charset=us-ascii"
	}
	mediaType, params, wellFormed := parseContentType(contentType)
	if !wellFormed {
		p.warn(fmt.Sprintf("malformed Content-Type %q, read as %s", clip(contentType, 120), mediaType))
	}

	if strings.HasPrefix(mediaType, "multipart/") {
		boundary := params["boundary"]
		if boundary == "" {
			p.keepUnreadable(r, transferEncoding)
			return
		}
		mr := multipart.NewReader(r, boundary)
		alternative := mediaType == "multipart/alternative"
		for {
			part, err := mr.NextPart()
			if err != nil {
				return
			}
			p.walk(part.Header.Get("Content-Type"), part.Header.Get("Content-Transfer-Encoding"),
				part.Header.Get("Content-Disposition"), part, depth+1, alternative)
		}
	}

	disp, dispParams := parseDisposition(disposition)
	filename := decodeHeader(dispParams["filename"])
	if filename == "" {
		filename = decodeHeader(params["name"])
	}
	isText := mediaType == "text/plain" || mediaType == "text/html"

	data, err := io.ReadAll(decodeTransfer(r, transferEncoding))
	if err != nil && len(data) == 0 {
		return
	}

	switch {
	case disp == "attachment":
		if filename == "" {
			filename = nameForPart(mediaType)
		}
		p.attach(filename, mediaType, data)
	case isText && (disp == "inline" || filename == "" || inAlternative):
		p.addText(mediaType, decodeCharset(data, params["charset"]))
		// A named part is also a file in its own right, and body() may well
		// prefer another part — an inline text/html "report.html" next to a
		// plain body would otherwise be stored nowhere. Inside a
		// multipart/alternative the part is the same body in another format,
		// so attaching it there would only add noise.
		if filename != "" && !inAlternative {
			p.attach(filename, mediaType, data)
		}
	case isText:
		p.named = append(p.named, namedText{text: decodeCharset(data, params["charset"]), isHTML: mediaType == "text/html"})
		p.attach(filename, mediaType, data)
	case filename != "":
		p.attach(filename, mediaType, data)
	case mediaType == "message/rfc822":
		p.attach("forwarded-message.eml", mediaType, data)
	default:
		// Inline images without filenames, text/calendar invites, etc: an
		// archival tool must not drop bytes on the floor.
		if len(data) > 0 {
			p.attach(nameForPart(mediaType), mediaType, data)
		}
	}
}

func (p *parser) addText(mediaType, text string) {
	if mediaType == "text/html" {
		p.html = append(p.html, text)
		return
	}
	p.plain = append(p.plain, text)
}

func (p *parser) attach(filename, mediaType string, data []byte) {
	p.out.Attachments = append(p.out.Attachments, Attachment{Filename: filename, MimeType: mediaType, Data: data})
}

func (p *parser) warn(msg string) { p.out.Warnings = append(p.out.Warnings, msg) }

// keepUnreadable archives a multipart part whose boundary could not be
// recovered. The bytes stay reachable through the attachment, and raw MIME
// syntax never becomes the searchable body.
func (p *parser) keepUnreadable(r io.Reader, transferEncoding string) {
	data, _ := io.ReadAll(decodeTransfer(r, transferEncoding))
	if len(data) == 0 {
		return
	}
	p.warn("multipart part has no usable boundary: raw bytes kept as an attachment")
	p.attach("unparsed-part.mime", "application/octet-stream", data)
}

// body picks the searchable text. Non-blank plain text wins, then HTML, then a
// named text part — a whitespace-only plain alternative must not suppress a
// real HTML one.
func (p *parser) body() string {
	if s := joinText(p.plain); s != "" {
		return s
	}
	if s := joinText(p.html); s != "" {
		return StripHTML(s)
	}
	for _, n := range p.named {
		if strings.TrimSpace(n.text) == "" {
			continue
		}
		if n.isHTML {
			return StripHTML(n.text)
		}
		return strings.TrimSpace(n.text)
	}
	return ""
}

func joinText(parts []string) string {
	kept := make([]string, 0, len(parts))
	for _, s := range parts {
		if strings.TrimSpace(s) != "" {
			kept = append(kept, s)
		}
	}
	return strings.TrimSpace(strings.Join(kept, "\n\n"))
}

var (
	mediaTypeRe = regexp.MustCompile(`^[a-z]+/[a-z0-9][a-z0-9.+_-]*`)
	paramRe     = regexp.MustCompile(`(?i)([a-z0-9*_-]+)\s*=\s*(?:"([^"]*)"|([^;]*))`)
)

// parseContentType is mime.ParseMediaType with a salvage path: real mail
// carries headers Go rejects — unquoted parameters with spaces, duplicate
// charsets, a truncated boundary. Falling straight back to text/plain would
// index a multipart body's own boundaries and part headers as the message
// text, so recover the media type and parameters leniently instead. The bool
// reports whether the header was well formed.
func parseContentType(v string) (string, map[string]string, bool) {
	if mediaType, params, err := mime.ParseMediaType(v); err == nil {
		return mediaType, params, true
	}
	head, _, _ := strings.Cut(v, ";")
	mediaType := mediaTypeRe.FindString(strings.ToLower(strings.TrimSpace(head)))
	params := lenientParams(v)
	if mediaType == "" {
		// Nothing usable in the type itself: only the word "multipart"
		// distinguishes MIME syntax from prose.
		if strings.Contains(strings.ToLower(v), "multipart") {
			return "multipart/mixed", params, false
		}
		return "text/plain", params, false
	}
	return mediaType, params, false
}

func parseDisposition(v string) (string, map[string]string) {
	if strings.TrimSpace(v) == "" {
		return "", map[string]string{}
	}
	if disp, params, err := mime.ParseMediaType(v); err == nil {
		return strings.ToLower(disp), params
	}
	head, _, _ := strings.Cut(v, ";")
	return strings.ToLower(strings.TrimSpace(head)), lenientParams(v)
}

// lenientParams pulls key=value pairs out of a header value the strict parser
// rejected. The first occurrence of a key wins.
func lenientParams(v string) map[string]string {
	out := map[string]string{}
	_, rest, ok := strings.Cut(v, ";")
	if !ok {
		return out
	}
	for _, m := range paramRe.FindAllStringSubmatch(rest, -1) {
		key := strings.ToLower(m[1])
		value := m[2]
		if value == "" {
			value = strings.TrimSpace(m[3])
		}
		if value == "" {
			continue
		}
		if _, seen := out[key]; !seen {
			out[key] = value
		}
	}
	return out
}

func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func nameForPart(mediaType string) string {
	if exts, _ := mime.ExtensionsByType(mediaType); len(exts) > 0 {
		return "unnamed" + exts[0]
	}
	return "unnamed"
}

func decodeTransfer(r io.Reader, encoding string) io.Reader {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "base64":
		return base64.NewDecoder(base64.StdEncoding, r)
	case "quoted-printable":
		return quotedprintable.NewReader(r)
	default:
		return r
	}
}

func decodeCharset(data []byte, charset string) string {
	r, err := charsetReader(charset, bytes.NewReader(data))
	if err != nil {
		return string(data)
	}
	decoded, err := io.ReadAll(r)
	if err != nil {
		return string(data)
	}
	return string(decoded)
}

func charsetReader(charset string, input io.Reader) (io.Reader, error) {
	switch strings.ToLower(strings.TrimSpace(charset)) {
	case "", "utf-8", "utf8", "us-ascii", "ascii":
		return input, nil
	}
	enc, err := htmlindex.Get(charset)
	if err != nil {
		return input, nil // unknown charset: pass bytes through rather than fail
	}
	return enc.NewDecoder().Reader(input), nil
}

func decodeHeader(s string) string {
	if decoded, err := wordDecoder.DecodeHeader(s); err == nil {
		return decoded
	}
	return s
}

func addressList(s string) []string {
	if s == "" {
		return nil
	}
	addrs, err := mail.ParseAddressList(decodeHeader(s))
	if err != nil {
		return []string{decodeHeader(s)}
	}
	out := make([]string, len(addrs))
	for i, a := range addrs {
		if a.Name != "" {
			out[i] = fmt.Sprintf("%s <%s>", a.Name, a.Address)
		} else {
			out[i] = a.Address
		}
	}
	return out
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

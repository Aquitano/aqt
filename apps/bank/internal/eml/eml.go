// Package eml parses RFC 822/MIME email and ingests it into the archive.
// It is shared by the Gmail sync (format=raw), ProtonMail exports (.eml) and
// Gmail Takeout (.mbox).
package eml

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	messagemail "github.com/emersion/go-message/mail"

	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/htmlindex"

	"github.com/aquitano/aqt/packages/go/extract"
)

type Attachment struct {
	Filename string
	MimeType string
	Data     []byte
}

type Message struct {
	NormalizedMessageID string
	InReplyTo           []string
	References          []string
	MessageID           string
	GmailThreadID       string
	From                string
	To                  []string
	Cc                  []string
	Subject             string
	Date                time.Time
	Body                string
	Attachments         []Attachment
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
	out := parseHeader(msg.Header)
	p := &parser{out: out}
	p.walk(msg.Header.Get("Content-Type"), msg.Header.Get("Content-Transfer-Encoding"), msg.Header.Get("Content-Disposition"), msg.Body, 0, false)
	out.Body = p.body()
	return out, nil
}

func parseHeader(h mail.Header) *Message {
	out := &Message{
		MessageID: strings.Trim(h.Get("Message-Id"), "<> \t"),
		From:      decodeHeader(h.Get("From")),
		To:        addressList(h.Get("To")),
		Cc:        addressList(h.Get("Cc")),
		Subject:   decodeHeader(h.Get("Subject")),
	}
	mailHeader := messagemail.HeaderFromMap(map[string][]string(h))
	out.NormalizedMessageID, _ = mailHeader.MessageID()
	if out.NormalizedMessageID == "" && !strings.ContainsAny(out.MessageID, "<> \t\r\n()") && strings.Contains(out.MessageID, "@") {
		out.NormalizedMessageID = out.MessageID
	}
	if !utf8.ValidString(out.NormalizedMessageID) || strings.ContainsFunc(out.NormalizedMessageID, unicode.IsControl) {
		out.NormalizedMessageID = ""
		out.Warnings = append(out.Warnings, "invalid Message-ID excluded from email grouping")
	}
	if len(out.NormalizedMessageID) > 1024 {
		out.NormalizedMessageID = ""
		out.Warnings = append(out.Warnings, "Message-ID exceeds email grouping limit")
	}
	for name, destination := range map[string]*[]string{"In-Reply-To": &out.InReplyTo, "References": &out.References} {
		if len(h.Get(name)) > 65536 {
			out.Warnings = append(out.Warnings, name+" exceeds email grouping limit")
			continue
		}
		ids, err := mailHeader.MsgIDList(name)
		if err != nil {
			out.Warnings = append(out.Warnings, "malformed "+name+": "+err.Error())
		}
		seen := make(map[string]bool)
		for _, id := range ids {
			if !utf8.ValidString(id) || strings.ContainsFunc(id, unicode.IsControl) {
				out.Warnings = append(out.Warnings, "invalid "+name+" ID excluded from email grouping")
				continue
			}
			if len(id) > 1024 || len(*destination) >= 128 {
				out.Warnings = append(out.Warnings, name+" exceeds email grouping limit")
				break
			}
			if !seen[id] && id != "" {
				*destination = append(*destination, id)
				seen[id] = true
			}
		}
	}
	if d, err := mail.ParseDate(h.Get("Date")); err == nil {
		out.Date = d
	}
	if thread, err := strconv.ParseUint(strings.TrimSpace(h.Get("X-GM-THRID")), 10, 64); err == nil {
		out.GmailThreadID = GmailThreadID(thread)
	}

	return out
}

// GmailThreadID renders Gmail's decimal X-GM-THRID in the hexadecimal form the
// Gmail API returns as threadId, so Takeout, IMAP and API mail share threads.
func GmailThreadID(thread uint64) string {
	return strconv.FormatUint(thread, 16)
}

// nativeThreadID prefers the explicit provider thread ID. Only an mbox, the
// form Takeout exports, falls back to the X-GM-THRID header: Takeout writes it,
// while in any other mail it is whatever the sender put there.
func (m *Message) nativeThreadID(explicit string, mbox bool) string {
	if explicit != "" || !mbox {
		return explicit
	}
	return m.GmailThreadID
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
// real HTML one. A plain part that leads with leaked CSS (some bulk senders
// generate the plain alternative by dumping the HTML including its <style>
// content) loses to a usable HTML part, and so does one that is only a stub
// (see plainIsStub).
func (p *parser) body() string {
	plain := joinText(p.plain)
	html := joinText(p.html)
	if plain != "" && !leadsWithCSS(plain) && !plainIsStub(plain, html) {
		return plain
	}
	if html != "" {
		return extract.StripHTML(html)
	}
	if plain != "" {
		return plain
	}
	for _, n := range p.named {
		if strings.TrimSpace(n.text) == "" {
			continue
		}
		if n.isHTML {
			return extract.StripHTML(n.text)
		}
		return strings.TrimSpace(n.text)
	}
	return ""
}

// stubMaxChars and stubRatio decide when a plain alternative is a stub rather
// than the message. Senders that build the plain part from a template ("this
// mail needs an HTML viewer", a subject line, a legal footer) leave something
// short that carries none of what was written, while the HTML part carries all
// of it. Both bounds have to hold: a short plain part beside a comparably short
// HTML one is a short message, not a stub, and a long plain part is the message
// however much markup the HTML alternative repeats it with.
const (
	stubMaxChars = 500
	stubRatio    = 3
)

// plainIsStub reports whether the HTML alternative is substantially richer than
// a short plain one. Measured against the stripped HTML, because the ratio has
// to compare text with text — tags alone would make every styled mail a stub.
func plainIsStub(plain, html string) bool {
	if html == "" || len(plain) >= stubMaxChars {
		return false
	}
	return len(extract.StripHTML(html)) > stubRatio*len(plain)
}

// cssJunkRe spots a stylesheet rule near the start of a text: a brace block
// carrying !important or an mso- property, which no human-written mail opens
// with.
var cssJunkRe = regexp.MustCompile(`(?s)^.{0,400}?\{[^{}]{0,300}(!important|mso-[a-z])`)

func leadsWithCSS(s string) bool {
	return cssJunkRe.MatchString(s)
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

// decodeHeader resolves RFC 2047 encoded words. A header carrying raw 8-bit
// bytes instead of encoded words — routine in old mail — is reinterpreted as
// Windows-1252 first, and it has to happen first: encoded words are pure
// ASCII, so the reinterpretation cannot touch them, while after word decoding
// the string mixes decoded UTF-8 with the raw bytes and no reinterpretation
// is safe. Left alone, those bytes would be stored as unrecoverable U+FFFD.
func decodeHeader(s string) string {
	if !utf8.ValidString(s) {
		if fixed, err := charmap.Windows1252.NewDecoder().String(s); err == nil {
			s = fixed
		}
	}
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

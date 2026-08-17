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

	var plain, htmlBody []string
	walkPart(h.Get("Content-Type"), h.Get("Content-Transfer-Encoding"), h.Get("Content-Disposition"),
		msg.Body, out, &plain, &htmlBody, 0)

	if len(plain) > 0 {
		out.Body = strings.TrimSpace(strings.Join(plain, "\n\n"))
	} else if len(htmlBody) > 0 {
		out.Body = StripHTML(strings.Join(htmlBody, "\n\n"))
	}
	return out, nil
}

func walkPart(contentType, transferEncoding, disposition string, r io.Reader, out *Message, plain, htmlBody *[]string, depth int) {
	if depth > 10 {
		return
	}
	if contentType == "" {
		contentType = "text/plain; charset=us-ascii"
	}
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		mediaType, params = "text/plain", map[string]string{}
	}

	if strings.HasPrefix(mediaType, "multipart/") {
		boundary := params["boundary"]
		if boundary == "" {
			return
		}
		mr := multipart.NewReader(r, boundary)
		for {
			p, err := mr.NextPart()
			if err != nil {
				return
			}
			walkPart(p.Header.Get("Content-Type"), p.Header.Get("Content-Transfer-Encoding"),
				p.Header.Get("Content-Disposition"), p, out, plain, htmlBody, depth+1)
		}
	}

	filename := partFilename(disposition, params)
	isAttachment := filename != "" || strings.HasPrefix(strings.ToLower(disposition), "attachment")

	data, err := io.ReadAll(decodeTransfer(r, transferEncoding))
	if err != nil && len(data) == 0 {
		return
	}

	switch {
	case isAttachment:
		if filename == "" {
			filename = "unnamed"
		}
		out.Attachments = append(out.Attachments, Attachment{Filename: filename, MimeType: mediaType, Data: data})
	case mediaType == "text/plain":
		*plain = append(*plain, decodeCharset(data, params["charset"]))
	case mediaType == "text/html":
		*htmlBody = append(*htmlBody, decodeCharset(data, params["charset"]))
	case mediaType == "message/rfc822":
		out.Attachments = append(out.Attachments, Attachment{Filename: "forwarded-message.eml", MimeType: mediaType, Data: data})
	}
}

func partFilename(disposition string, typeParams map[string]string) string {
	if disposition != "" {
		if _, p, err := mime.ParseMediaType(disposition); err == nil && p["filename"] != "" {
			return decodeHeader(p["filename"])
		}
	}
	return decodeHeader(typeParams["name"])
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

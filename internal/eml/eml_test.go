package eml

import (
	"strings"
	"testing"
)

const multipartMail = "From: =?UTF-8?Q?Bj=C3=B6rn?= <bjoern@example.com>\r\n" +
	"To: Thomas <thomas@example.com>, second@example.com\r\n" +
	"Subject: =?UTF-8?B?SW52b2ljZSDDvGJlcndlaXN1bmc=?=\r\n" +
	"Date: Mon, 13 May 2024 21:08:00 +0200\r\n" +
	"Message-ID: <abc123@example.com>\r\n" +
	"MIME-Version: 1.0\r\n" +
	"Content-Type: multipart/mixed; boundary=OUTER\r\n" +
	"\r\n" +
	"--OUTER\r\n" +
	"Content-Type: multipart/alternative; boundary=INNER\r\n" +
	"\r\n" +
	"--INNER\r\n" +
	"Content-Type: text/plain; charset=utf-8\r\n" +
	"Content-Transfer-Encoding: quoted-printable\r\n" +
	"\r\n" +
	"Hi Thomas, die =C3=9Cberweisung ist raus.\r\n" +
	"--INNER\r\n" +
	"Content-Type: text/html; charset=utf-8\r\n" +
	"\r\n" +
	"<p>Hi Thomas, die &Uuml;berweisung ist raus.</p>\r\n" +
	"--INNER--\r\n" +
	"--OUTER\r\n" +
	"Content-Type: application/pdf; name=\"invoice.pdf\"\r\n" +
	"Content-Transfer-Encoding: base64\r\n" +
	"Content-Disposition: attachment; filename=\"invoice.pdf\"\r\n" +
	"\r\n" +
	"JVBERi0xLjQK\r\n" +
	"--OUTER--\r\n"

func TestParseMultipart(t *testing.T) {
	m, err := Parse([]byte(multipartMail))
	if err != nil {
		t.Fatal(err)
	}
	if m.From != "Björn <bjoern@example.com>" {
		t.Errorf("From = %q", m.From)
	}
	if m.Subject != "Invoice überweisung" {
		t.Errorf("Subject = %q", m.Subject)
	}
	if len(m.To) != 2 {
		t.Errorf("To = %v", m.To)
	}
	if m.MessageID != "abc123@example.com" {
		t.Errorf("MessageID = %q", m.MessageID)
	}
	if want := "Hi Thomas, die Überweisung ist raus."; m.Body != want {
		t.Errorf("Body = %q, want %q (plain part preferred over html)", m.Body, want)
	}
	if len(m.Attachments) != 1 {
		t.Fatalf("attachments = %+v", m.Attachments)
	}
	a := m.Attachments[0]
	if a.Filename != "invoice.pdf" || string(a.Data) != "%PDF-1.4\n" {
		t.Errorf("attachment = %q data=%q", a.Filename, a.Data)
	}
	if m.Date.IsZero() {
		t.Error("Date not parsed")
	}
}

func TestParseHTMLOnly(t *testing.T) {
	mail := "From: a@example.com\r\nSubject: hi\r\nContent-Type: text/html; charset=utf-8\r\n\r\n" +
		"<html><head><style>p{color:red}</style></head><body><p>line one</p><p>line &amp; two</p></body></html>"
	m, err := Parse([]byte(mail))
	if err != nil {
		t.Fatal(err)
	}
	if want := "line one\nline & two"; m.Body != want {
		t.Errorf("Body = %q, want %q", m.Body, want)
	}
}

func TestSplitMbox(t *testing.T) {
	mbox := "From 1234@xxx Mon May 13 21:08:00 2024\n" +
		"From: a@example.com\nSubject: first\n\nbody one\n>From quoted line\n" +
		"From 5678@xxx Mon May 13 21:09:00 2024\n" +
		"From: b@example.com\nSubject: second\n\nbody two\n"
	var msgs []string
	if err := SplitMbox(strings.NewReader(mbox), func(raw []byte) error {
		msgs = append(msgs, string(raw))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want 2", len(msgs))
	}
	if !strings.Contains(msgs[0], "body one\nFrom quoted line") {
		t.Errorf("mboxrd unquoting failed: %q", msgs[0])
	}
	if !strings.Contains(msgs[1], "Subject: second") {
		t.Errorf("second message = %q", msgs[1])
	}
}

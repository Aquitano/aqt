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

func TestSplitMboxUnquotedFromLine(t *testing.T) {
	// mboxo producers (Thunderbird) do not quote body lines starting with
	// "From "; only a "From " line after a blank line is a separator.
	mbox := "From 1@xxx Mon May 13 21:08:00 2024\n" +
		"From: a@example.com\nSubject: first\n\nline one\nFrom now on, this is body text\nline three\n\n" +
		"From 2@xxx Mon May 13 21:09:00 2024\n" +
		"From: b@example.com\nSubject: second\n\nbody two\n"
	var msgs []string
	if err := SplitMbox(strings.NewReader(mbox), func(raw []byte) error {
		msgs = append(msgs, string(raw))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want 2: %q", len(msgs), msgs)
	}
	if !strings.Contains(msgs[0], "From now on, this is body text\nline three") {
		t.Errorf("body with unquoted From line was truncated: %q", msgs[0])
	}
}

func TestInlineImageWithoutFilenameKept(t *testing.T) {
	mail := "From: a@example.com\r\nSubject: newsletter\r\nMIME-Version: 1.0\r\n" +
		"Content-Type: multipart/related; boundary=B\r\n\r\n" +
		"--B\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>see image</p>\r\n" +
		"--B\r\nContent-Type: image/png\r\nContent-ID: <img1>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n" +
		"--B--\r\n"
	m, err := Parse([]byte(mail))
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Attachments) != 1 || m.Attachments[0].MimeType != "image/png" {
		t.Fatalf("inline image dropped: %+v", m.Attachments)
	}
	if !strings.HasPrefix(m.Attachments[0].Filename, "unnamed") {
		t.Errorf("filename = %q", m.Attachments[0].Filename)
	}
}

func TestSplitMbox(t *testing.T) {
	mbox := "From 1234@xxx Mon May 13 21:08:00 2024\n" +
		"From: a@example.com\nSubject: first\n\nbody one\n>From quoted line\n\n" +
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

func TestBlankPlainAlternativeFallsBackToHTML(t *testing.T) {
	build := func(plain string) []byte {
		return []byte("From: a@example.com\r\nSubject: hi\r\nMIME-Version: 1.0\r\n" +
			"Content-Type: multipart/alternative; boundary=B\r\n\r\n" +
			"--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" + plain + "\r\n" +
			"--B\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>the real body</p>\r\n" +
			"--B--\r\n")
	}
	for name, plain := range map[string]string{"empty": "", "whitespace": "   \r\n\t"} {
		t.Run(name, func(t *testing.T) {
			m, err := Parse(build(plain))
			if err != nil {
				t.Fatal(err)
			}
			if m.Body != "the real body" {
				t.Errorf("Body = %q, want the HTML alternative", m.Body)
			}
		})
	}
	t.Run("nonempty plain still wins", func(t *testing.T) {
		m, err := Parse(build("plain wins"))
		if err != nil {
			t.Fatal(err)
		}
		if m.Body != "plain wins" {
			t.Errorf("Body = %q, want the plain alternative", m.Body)
		}
	})
}

func TestNamedInlineTextIsBody(t *testing.T) {
	cases := []struct {
		name       string
		mail       string
		wantBody   string
		wantAttach int
	}{
		{
			name: "inline disposition with a name",
			mail: "From: a@example.com\r\nSubject: hi\r\n" +
				"Content-Type: text/plain; charset=utf-8; name=\"message.txt\"\r\n" +
				"Content-Disposition: inline; filename=\"message.txt\"\r\n\r\nthe body",
			wantBody: "the body",
		},
		{
			name: "alternative part with a name",
			mail: "From: a@example.com\r\nSubject: hi\r\nMIME-Version: 1.0\r\n" +
				"Content-Type: multipart/alternative; boundary=B\r\n\r\n" +
				"--B\r\nContent-Type: text/plain; charset=utf-8; name=\"body.txt\"\r\n\r\nthe body\r\n" +
				"--B--\r\n",
			wantBody: "the body",
		},
		{
			name: "sole named part with no disposition",
			mail: "From: a@example.com\r\nSubject: hi\r\n" +
				"Content-Type: text/plain; charset=utf-8; name=\"note.txt\"\r\n\r\nthe body",
			wantBody:   "the body",
			wantAttach: 1, // ambiguous: kept as an attachment too, nothing is lost
		},
		{
			name: "explicit attachment stays an attachment",
			mail: "From: a@example.com\r\nSubject: hi\r\nMIME-Version: 1.0\r\n" +
				"Content-Type: multipart/mixed; boundary=B\r\n\r\n" +
				"--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nthe body\r\n" +
				"--B\r\nContent-Type: text/plain; charset=utf-8; name=\"notes.txt\"\r\n" +
				"Content-Disposition: attachment; filename=\"notes.txt\"\r\n\r\nattached notes\r\n" +
				"--B--\r\n",
			wantBody:   "the body",
			wantAttach: 1,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m, err := Parse([]byte(tc.mail))
			if err != nil {
				t.Fatal(err)
			}
			if m.Body != tc.wantBody {
				t.Errorf("Body = %q, want %q", m.Body, tc.wantBody)
			}
			if len(m.Attachments) != tc.wantAttach {
				t.Errorf("attachments = %d, want %d: %+v", len(m.Attachments), tc.wantAttach, m.Attachments)
			}
			if strings.Contains(m.Body, "attached notes") {
				t.Error("an explicit attachment was merged into the body")
			}
		})
	}
}

func TestMalformedContentType(t *testing.T) {
	t.Run("boundary recoverable", func(t *testing.T) {
		// An unquoted boundary containing a space is what Go's strict parser
		// rejects; the parts are still perfectly readable.
		mail := "From: a@example.com\r\nSubject: hi\r\nMIME-Version: 1.0\r\n" +
			"Content-Type: multipart/mixed; boundary=B; charset=\r\n\r\n" +
			"--B\r\nContent-Type: text/plain\r\n\r\nreadable text\r\n" +
			"--B\r\nContent-Type: application/pdf; name=\"x.pdf\"\r\n\r\nPDFBYTES\r\n" +
			"--B--\r\n"
		m, err := Parse([]byte(mail))
		if err != nil {
			t.Fatal(err)
		}
		if m.Body != "readable text" {
			t.Errorf("Body = %q", m.Body)
		}
		if len(m.Attachments) != 1 || m.Attachments[0].Filename != "x.pdf" {
			t.Errorf("attachments = %+v", m.Attachments)
		}
		if len(m.Warnings) == 0 {
			t.Error("a salvaged Content-Type should be reported")
		}
	})

	t.Run("boundary unrecoverable", func(t *testing.T) {
		mail := "From: a@example.com\r\nSubject: hi\r\nMIME-Version: 1.0\r\n" +
			"Content-Type: multipart/mixed;;;\r\n\r\n" +
			"--WHATEVER\r\nContent-Type: text/plain\r\n\r\nsome text\r\n" +
			"--WHATEVER--\r\n"
		m, err := Parse([]byte(mail))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(m.Body, "--WHATEVER") || strings.Contains(m.Body, "Content-Type:") {
			t.Errorf("raw multipart syntax was indexed as the body: %q", m.Body)
		}
		if len(m.Attachments) != 1 {
			t.Fatalf("unreadable bytes were dropped instead of kept: %+v", m.Attachments)
		}
		if !strings.Contains(string(m.Attachments[0].Data), "some text") {
			t.Errorf("kept bytes = %q", m.Attachments[0].Data)
		}
		if len(m.Warnings) == 0 {
			t.Error("an unreadable structure should be reported")
		}
	})

	t.Run("nested malformed part", func(t *testing.T) {
		mail := "From: a@example.com\r\nSubject: hi\r\nMIME-Version: 1.0\r\n" +
			"Content-Type: multipart/mixed; boundary=OUTER\r\n\r\n" +
			"--OUTER\r\nContent-Type: text/plain\r\n\r\nouter text\r\n" +
			"--OUTER\r\nContent-Type: multipart/alternative\r\n\r\n" +
			"--INNER\r\nContent-Type: text/plain\r\n\r\ninner text\r\n--INNER--\r\n" +
			"--OUTER--\r\n"
		m, err := Parse([]byte(mail))
		if err != nil {
			t.Fatal(err)
		}
		if m.Body != "outer text" {
			t.Errorf("Body = %q, want only the readable part", m.Body)
		}
		if len(m.Warnings) == 0 {
			t.Error("a boundary-less nested multipart should be reported")
		}
	})
}

func TestSplitMboxSeparatorAfterNonblankLine(t *testing.T) {
	// Gmail Takeout writes the numeric zone before the year; Thunderbird
	// writes a bare "-" as the address. Neither message here ends on a blank
	// line, which is exactly what the old previous-line heuristic missed.
	mbox := "From 1@xxx Mon May 13 21:08:00 +0000 2024\n" +
		"From: a@example.com\nSubject: first\n\nbody one\n" +
		"From - Mon May 13 21:09:00 2024\n" +
		"From: b@example.com\nSubject: second\n\nbody two\n"
	var msgs []string
	if err := SplitMbox(strings.NewReader(mbox), func(raw []byte) error {
		msgs = append(msgs, string(raw))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want 2: %q", len(msgs), msgs)
	}
	if !strings.Contains(msgs[0], "Subject: first") || !strings.Contains(msgs[1], "Subject: second") {
		t.Errorf("messages split wrongly: %q", msgs)
	}
}

func TestSplitMboxBodyLineAfterBlankLineIsNotASeparator(t *testing.T) {
	// The shape of the envelope, not the blank line before it, is what makes a
	// separator — otherwise ordinary prose splits a message in half.
	mbox := "From 1@xxx Mon May 13 21:08:00 2024\n" +
		"From: a@example.com\nSubject: only\n\nline one\n\nFrom then on we agreed\nline three\n"
	var msgs []string
	if err := SplitMbox(strings.NewReader(mbox), func(raw []byte) error {
		msgs = append(msgs, string(raw))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 {
		t.Fatalf("got %d messages, want 1: %q", len(msgs), msgs)
	}
	if !strings.Contains(msgs[0], "From then on we agreed\nline three") {
		t.Errorf("body was truncated: %q", msgs[0])
	}
}

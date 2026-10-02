package archive

import "testing"

func TestMailContextPaths(t *testing.T) {
	for _, mailbox := range []string{"/Archive", "Projects/../Notes", "Work!", "Work", "Grüße/收件箱"} {
		observation := MailImportContext{Version: 1, Kind: "imap", Mailbox: mailbox, RelativePath: "message.eml"}
		if err := observation.Validate(); err != nil {
			t.Fatalf("opaque mailbox %q: %v", mailbox, err)
		}
	}
	for _, relative := range []string{"", "/mail.eml", "../mail.eml", "a/../b", `C:\mail.eml`, `a\..\b`, "a\x00b"} {
		observation := MailImportContext{Version: 1, Kind: "export", Mailbox: "Work", RelativePath: relative}
		if err := observation.Validate(); err == nil {
			t.Fatalf("unsafe relative path accepted: %q", relative)
		}
	}
	for _, raw := range []string{"other/mail.eml", "mail/../other.eml", "/mail/mail.eml", "mail/.mail-contexts/record.json"} {
		if err := (MailContextRecord{Version: 1, Source: "mail", RawRef: raw, InputKind: "eml"}).Validate(); err == nil {
			t.Fatalf("unsafe raw reference: %q", raw)
		}
	}
}

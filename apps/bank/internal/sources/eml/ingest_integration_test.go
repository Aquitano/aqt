package eml

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/importer/importtest"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

var (
	emlKind  = importer.Register(EML{}, "")
	mboxKind = importer.Register(Mbox{}, "")
)

const twoAttachmentMail = "From: a@example.com\r\n" +
	"To: b@example.com\r\n" +
	"Subject: two files\r\n" +
	"Date: Mon, 13 May 2024 21:08:00 +0200\r\n" +
	"Message-ID: <two@example.com>\r\n" +
	"MIME-Version: 1.0\r\n" +
	"Content-Type: multipart/mixed; boundary=B\r\n\r\n" +
	"--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nsee attached\r\n" +
	"--B\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"one.pdf\"\r\n\r\nFIRST\r\n" +
	"--B\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"two.pdf\"\r\n\r\nSECOND\r\n" +
	"--B--\r\n"

func mailTarget(t *testing.T, st *store.Store) importer.Target {
	t.Helper()
	return importtest.On(t, st, emlKind, mboxKind)
}

// importRaw imports raw as one input named name. It does not touch t, so
// concurrent tests can call it from their own goroutines.
func importRaw(target importer.Target, kind, name, raw string, options any) (store.RawInput, error) {
	encoded, err := json.Marshal(options)
	if err != nil {
		return store.RawInput{}, err
	}
	return importer.Import(context.Background(), target, kind, name, bytes.NewReader([]byte(raw)), encoded)
}

func mustImportRaw(t *testing.T, target importer.Target, kind, name, raw string, options any) store.RawInput {
	t.Helper()
	got, err := importRaw(target, kind, name, raw, options)
	if err != nil {
		t.Fatalf("import %s: %v", name, err)
	}
	return got
}

func TestImportingTheSameMailTwiceAddsNothing(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	target := mailTarget(t, st)
	first := mustImportRaw(t, target, "eml", "two.eml", twoAttachmentMail, EMLOptions{})
	if first.Report.Inserted != 1 || first.Report.Attachments != 2 {
		t.Fatalf("first import: %+v", first.Report)
	}
	second := mustImportRaw(t, target, "eml", "two.eml", twoAttachmentMail, EMLOptions{})
	if second.Report.Inserted != 0 || second.Report.Duplicates != 1 || second.Report.Attachments != 0 {
		t.Fatalf("second import: %+v", second.Report)
	}
	id, err := st.FindByEmailMessageID(ctx, "proton", "two@example.com")
	if err != nil {
		t.Fatal(err)
	}
	message, err := st.GetMessageDetail(ctx, id)
	if err != nil || len(message.Attachments) != 2 || message.RawInput != first.ID {
		t.Fatalf("message: %+v, %v", message, err)
	}
}

func TestUnparseableMailIsRejectedNotFailed(t *testing.T) {
	target := mailTarget(t, storetest.New(t))
	raw := mustImportRaw(t, target, "eml", "broken.eml", "this is not a header\r\n\r\nbody", EMLOptions{})
	if raw.Status != "gaps" || raw.Report.Issues[ingest.Rejected] != 1 || raw.Report.Inserted != 0 {
		t.Fatalf("unparseable mail: %+v", raw)
	}
}

func TestImportMboxReportsAFileThatDidNotSplit(t *testing.T) {
	// The second separator is in a dialect the splitter does not know (a
	// two-digit year), so both messages arrive as one and the import would
	// otherwise report a clean "1 new".
	merged := "From a@example.com Mon May 13 21:08:00 2024\n" +
		"From: a@example.com\nSubject: first\n\nbody one\n" +
		"From b@example.com Mon May 13 21:09:00 24\n" +
		"From: b@example.com\nSubject: second\n\nbody two\n"
	clean := "From a@example.com Mon May 13 21:08:00 2024\n" +
		"From: a@example.com\nSubject: only\n\nbody one\n"

	for name, tc := range map[string]struct {
		mbox        string
		wantWarning bool
	}{
		"merged file is reported": {merged, true},
		"a single message is not": {clean, false},
	} {
		t.Run(name, func(t *testing.T) {
			target := mailTarget(t, storetest.New(t))
			raw := mustImportRaw(t, target, "mbox", "All mail.mbox", tc.mbox, MboxOptions{})
			if raw.Report.Inserted != 1 {
				t.Fatalf("report = %+v, want the one message the splitter found", raw.Report)
			}
			if got := raw.Report.Issues[ingest.Incomplete] > 0; got != tc.wantWarning {
				t.Errorf("warned = %v, want %v; report = %+v", got, tc.wantWarning, raw.Report)
			}
		})
	}
}

func TestImportSkipsRetiredMail(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	target := mailTarget(t, st)
	options := EMLOptions{ExternalID: "mail:two"}
	mustImportRaw(t, target, "eml", "two.eml", twoAttachmentMail, options)
	if _, err := st.RetireMessages(ctx, store.RetireOptions{Source: "proton", ExternalPrefixes: []string{"mail:"}, Apply: true}); err != nil {
		t.Fatal(err)
	}
	raw := mustImportRaw(t, target, "eml", "two.eml", twoAttachmentMail, options)
	if raw.Report.Inserted != 0 || raw.Report.Retired != 1 || raw.Report.Attachments != 0 {
		t.Fatalf("replayed retired mail: %+v", raw.Report)
	}
}

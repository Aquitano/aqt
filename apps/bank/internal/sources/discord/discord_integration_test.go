package discord

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/importer/importtest"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

var kind = importer.Register(Source{}, "Discord data package")

// packageDir writes a minimal unpacked Discord data package.
func packageDir(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	write := func(rel, content string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("account/user.json", `{"username":"me"}`)
	write("messages/index.json", `{"1":"Direct Message with alice","2":"Direct Message with bob","3":"general"}`)
	write("messages/c1/messages.csv",
		"ID,Timestamp,Contents,Attachments\n11,2021-05-06 12:34:56,hello alice,\n")
	// Truncated JSON: the channel is unreadable, the rest of the package is not.
	write("messages/c2/messages.json", `[{"ID": 22, "Timestamp":`)
	write("messages/c3/messages.csv",
		"ID,Timestamp,Contents,Attachments\n33,2021-05-06 12:40:00,hello general,\n")
	return root
}

func TestImportReportsSkippedChannels(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	got, err := importtest.Import(t, importtest.On(t, st, kind), "discord", packageDir(t), nil)
	if err != nil {
		t.Fatalf("one malformed channel aborted the package: %v", err)
	}
	if got.Report.Inserted != 2 || got.Status != "gaps" {
		t.Errorf("valid channels were discarded or the gap is hidden: %+v %s", got.Report, got.Status)
	}
	if got.Report.Issues[ingest.Rejected] != 1 || len(got.Report.Details) != 1 ||
		!strings.Contains(got.Report.Details[0].Detail, "Direct Message with bob") {
		t.Fatalf("issues = %+v, want the one unreadable channel by name", got.Report.Details)
	}

	// The thread is the channel id, not the name every server reuses.
	th, err := st.GetThread(ctx, "discord", "3", 0)
	if err != nil {
		t.Fatalf("no thread for channel id 3: %v", err)
	}
	if len(th.Messages) != 1 || th.Messages[0].Subject != "general" {
		t.Errorf("thread 3 = %+v, want the one message carrying the channel name as subject", th.Messages)
	}
	if _, err := st.GetThread(ctx, "discord", "general", 0); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("the channel name is still a thread: %v", err)
	}
}

func TestImportOfAHealthyPackageReportsNoFailures(t *testing.T) {
	root := packageDir(t)
	if err := os.RemoveAll(filepath.Join(root, "messages", "c2")); err != nil {
		t.Fatal(err)
	}
	got := importtest.MustImport(t, importtest.Target(t, kind), "discord", root, nil)
	if got.Status != "complete" || len(got.Report.Details) != 0 {
		t.Errorf("import = %+v, want complete with no issues", got)
	}
}

package discord

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aquitano/aqt-bank/internal/storetest"
)

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
	res, err := Import(ctx, st, filepath.Join(t.TempDir(), "archive"), packageDir(t))
	if err != nil {
		t.Fatalf("one malformed channel aborted the package: %v", err)
	}
	if res.Inserted != 2 || res.Channels != 2 {
		t.Errorf("valid channels were discarded: %+v", res)
	}
	if len(res.FailedChannels) != 1 || res.FailedChannels[0] != "Direct Message with bob" {
		t.Fatalf("failed channels = %v, want the one unreadable channel by name", res.FailedChannels)
	}

	// The partial success has to survive serialization, which is all a JSON
	// consumer ever sees.
	raw, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	var round Result
	if err := json.Unmarshal(raw, &round); err != nil {
		t.Fatal(err)
	}
	if len(round.FailedChannels) != 1 {
		t.Errorf("failed_channels did not survive JSON: %s", raw)
	}
}

func TestImportOfAHealthyPackageReportsNoFailures(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	root := packageDir(t)
	if err := os.RemoveAll(filepath.Join(root, "messages", "c2")); err != nil {
		t.Fatal(err)
	}
	res, err := Import(ctx, st, filepath.Join(t.TempDir(), "archive"), root)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.FailedChannels) != 0 {
		t.Errorf("failed channels = %v, want none", res.FailedChannels)
	}
	raw, _ := json.Marshal(res)
	if strings.Contains(string(raw), "failed_channels") {
		t.Errorf("an undamaged import should not carry failed_channels: %s", raw)
	}
}

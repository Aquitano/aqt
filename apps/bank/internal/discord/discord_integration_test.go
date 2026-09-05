package discord

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
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

// An archive filled before threads were keyed on channel ids holds its
// messages under the channel name. Re-importing the same package must move
// them onto the id, and still count them as already known.
func TestImportRekeysStoredMessages(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)

	if _, err := st.InsertMessage(ctx, store.Message{
		Source:     "discord",
		ExternalID: "33",
		ThreadID:   "general", // what the old name-keyed import stored
		Sender:     "me",
		Body:       "hello general",
		SentAt:     time.Date(2021, 5, 6, 12, 40, 0, 0, time.UTC),
	}); err != nil {
		t.Fatal(err)
	}

	res, err := Import(ctx, st, filepath.Join(t.TempDir(), "archive"), packageDir(t))
	if err != nil {
		t.Fatal(err)
	}
	if res.Inserted != 1 || res.Duplicates != 1 {
		t.Errorf("a re-keyed message is still already known: %+v", res)
	}
	th, err := st.GetThread(ctx, "discord", "3", 0)
	if err != nil {
		t.Fatalf("message was not re-keyed onto the channel id: %v", err)
	}
	if len(th.Messages) != 1 || th.Messages[0].Subject != "general" {
		t.Errorf("thread 3 = %+v, want the one message carrying the channel name as subject", th.Messages)
	}
	if _, err := st.GetThread(ctx, "discord", "general", 0); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("the old name-keyed thread survived: %v", err)
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

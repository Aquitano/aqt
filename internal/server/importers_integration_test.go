package server

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt-bank/internal/blob"
	"github.com/aquitano/aqt-bank/internal/fail"
	"github.com/aquitano/aqt-bank/internal/storetest"
)

// A database outage has to reach the caller as an operational failure from
// every importer: inbox files anything else under .rejected/, so a Postgres
// restart during the import cron would quarantine perfectly good exports, and
// this route would answer 400 instead of 5xx. importFile is the one place that
// knows every importer, which makes it the seam that catches the next one.
func TestImportersReportADatabaseOutageAsOperational(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	dir := t.TempDir()
	blobs, err := blob.New(filepath.Join(dir, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{db: st, blobs: blobs, dataDir: dir, archiveDir: filepath.Join(dir, "archive")}

	write := func(rel, content string) string {
		t.Helper()
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	write("discord/messages/index.json", `{"1":"Direct Message with alice"}`)
	write("discord/messages/c1/messages.csv", "ID,Timestamp,Contents,Attachments\n11,2021-05-06 12:34:56,hello alice,\n")

	inputs := map[string]string{
		"whatsapp": write("whatsapp/WhatsApp Chat with Alice.txt", "13/05/2024, 21:08 - Alice: hello\n"),
		"eml":      write("eml/one.eml", "From: a@example.com\r\nSubject: hi\r\nMessage-ID: <one@example.com>\r\n\r\nbody\r\n"),
		"mbox":     write("mbox/all.mbox", "From a@example.com Mon May 13 21:08:00 2024\nFrom: a@example.com\nSubject: hi\n\nbody\n"),
		"linkedin": write("linkedin/messages.csv",
			"CONVERSATION ID,FROM,TO,DATE,SUBJECT,CONTENT\nc-1,Jane,Thomas,2023-05-13 21:08:45 UTC,hi,hello there\n"),
		"chatgpt": write("chatgpt/conversations.json",
			`[{"title":"t","conversation_id":"c-1","mapping":{"n":{"message":{"id":"m-1","author":{"role":"user"},`+
				`"create_time":1715629680.5,"content":{"content_type":"text","parts":["hello"]}}}}}]`),
		"claude": write("claude/conversations.json",
			`[{"uuid":"c-1","name":"t","chat_messages":[{"uuid":"m-1","sender":"human",`+
				`"created_at":"2024-05-13T21:08:00Z","text":"hello"}]}]`),
		"claude-code": filepath.Dir(write("claude-code/s.jsonl",
			`{"type":"user","uuid":"u-1","timestamp":"2026-08-17T10:00:00.000Z","message":{"role":"user","content":"hello"}}`+"\n")),
		"discord": filepath.Join(dir, "discord"),
	}

	st.Close() // the outage

	for kind, path := range inputs {
		t.Run(kind, func(t *testing.T) {
			_, err := s.importFile(ctx, kind, "", path)
			if err == nil {
				t.Fatal("importing into a closed database should fail")
			}
			if !fail.IsOp(err) {
				t.Errorf("err = %v, which inbox files as rejected input and this route answers 400 for", err)
			}
		})
	}
}

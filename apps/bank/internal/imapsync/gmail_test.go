package imapsync

import (
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	gmailimap "github.com/emersion/go-imap"
	"github.com/emersion/go-imap/backend"
	"github.com/emersion/go-imap/backend/memory"
	gmailserver "github.com/emersion/go-imap/server"

	"github.com/aquitano/aqt/apps/bank/internal/eml"
)

type gmailItems map[uint32]map[gmailimap.FetchItem]any

type gmailTestBackend struct {
	*memory.Backend
	items gmailItems
}

func (server gmailTestBackend) Login(info *gmailimap.ConnInfo, username, password string) (backend.User, error) {
	user, err := server.Backend.Login(info, username, password)
	if err != nil {
		return nil, err
	}
	return gmailTestUser{User: user, items: server.items}, nil
}

type gmailTestUser struct {
	backend.User
	items gmailItems
}

func (user gmailTestUser) ListMailboxes(subscribed bool) ([]backend.Mailbox, error) {
	mailboxes, err := user.User.ListMailboxes(subscribed)
	for index, mailbox := range mailboxes {
		mailboxes[index] = gmailTestMailbox{Mailbox: mailbox, items: user.items}
	}
	return mailboxes, err
}

func (user gmailTestUser) GetMailbox(name string) (backend.Mailbox, error) {
	mailbox, err := user.User.GetMailbox(name)
	if err != nil {
		return nil, err
	}
	return gmailTestMailbox{Mailbox: mailbox, items: user.items}, nil
}

type gmailTestMailbox struct {
	backend.Mailbox
	items gmailItems
}

func (mailbox gmailTestMailbox) Info() (*gmailimap.MailboxInfo, error) {
	info, err := mailbox.Mailbox.Info()
	if err == nil && info.Name == "[Gmail]/Sent Mail" {
		info.Attributes = append(info.Attributes, gmailimap.SentAttr)
	}
	return info, err
}

func (mailbox gmailTestMailbox) ListMessages(uid bool, set *gmailimap.SeqSet, items []gmailimap.FetchItem, messages chan<- *gmailimap.Message) error {
	defer close(messages)
	standard := slices.DeleteFunc(slices.Clone(items), func(item gmailimap.FetchItem) bool { return strings.HasPrefix(string(item), "X-GM-") })
	listed := make(chan *gmailimap.Message)
	done := make(chan error, 1)
	go func() { done <- mailbox.Mailbox.ListMessages(uid, set, standard, listed) }()
	for message := range listed {
		if len(standard) != len(items) {
			for item, value := range mailbox.items[message.Uid] {
				message.Items[item] = value
			}
		}
		messages <- message
	}
	return <-done
}

type gmailTestExtension struct{}

func (gmailTestExtension) Capabilities(gmailserver.Conn) []string { return []string{"X-GM-EXT-1"} }

func (gmailTestExtension) Command(string) gmailserver.HandlerFactory { return nil }

func TestGmailThreadAndLabelsTravelWithUpload(t *testing.T) {
	t.Setenv("BANK_TEST_GMAIL_USER", "username")
	t.Setenv("BANK_TEST_GMAIL_PASSWORD", "password")
	dir := t.TempDir()
	tlsConfig, caFile := testTLS(t, dir)
	mailboxes := memory.New()
	user, err := mailboxes.Login(nil, "username", "password")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"[Gmail]/All Mail", "[Gmail]/Sent Mail"} {
		if err := user.CreateMailbox(name); err != nil {
			t.Fatal(err)
		}
	}
	allMail, err := user.GetMailbox("[Gmail]/All Mail")
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"labelled", "archived"} {
		if err := allMail.CreateMessage(nil, time.Now(), bytes.NewBuffer(rawMessage(id))); err != nil {
			t.Fatal(err)
		}
	}
	server := gmailserver.New(gmailTestBackend{Backend: mailboxes, items: gmailItems{
		1: {"X-GM-THRID": gmailimap.RawString("1278455344230334865"), "X-GM-LABELS": []any{`\Inbox`, gmailimap.RawString(`\Sent`), "Work/Receipts", "&AMk-tiquette", `\Important`}},
		2: {"X-GM-THRID": gmailimap.RawString("1278455344230334866"), "X-GM-LABELS": []any{}},
	}})
	server.ErrorLog = log.New(io.Discard, "", 0)
	server.Enable(gmailTestExtension{})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	served := make(chan error, 1)
	go func() { served <- server.Serve(tls.NewListener(listener, tlsConfig)) }()
	t.Cleanup(func() {
		_ = server.Close()
		<-served
	})
	config := Config{
		StateDir: filepath.Join(dir, "state"), Interval: "1s", Timeout: "5s", Workers: 2, BatchSize: 2, MaxMessageBytes: 1 << 20,
		Accounts: []Account{{ID: "gmail", Source: "gmail", Address: listener.Addr().String(), UsernameEnv: "BANK_TEST_GMAIL_USER", PasswordEnv: "BANK_TEST_GMAIL_PASSWORD", TLS: "tls", CAFile: caFile, Folders: []string{"[Gmail]/All Mail"}}},
	}

	var mutex sync.Mutex
	observed := map[string]eml.MailImportContext{}
	importer := func(available bool) Importer {
		return func(_ context.Context, _, path string, observation eml.MailImportContext) (eml.Result, error) {
			raw, err := os.ReadFile(path)
			if err != nil {
				return eml.Result{}, err
			}
			message, err := eml.Parse(raw)
			if err != nil {
				return eml.Result{}, err
			}
			observation.RelativePath = ""
			mutex.Lock()
			observed[message.MessageID] = observation
			mutex.Unlock()
			if !available {
				return eml.Result{}, fmt.Errorf("Bank unavailable")
			}
			return eml.Result{Inserted: 1, MailContextVersion: observation.Version}, nil
		}
	}
	base := eml.MailImportContext{Version: 2, Kind: "imap", Mailbox: "[Gmail]/All Mail", AccountID: "gmail"}
	labelled, archived := base, base
	labelled.ThreadID, labelled.Labels = "11bdfc5cae0c8191", []string{"INBOX", "[Gmail]/Sent Mail", "Work/Receipts", "Étiquette", `\Important`}
	archived.ThreadID = "11bdfc5cae0c8192"
	want := map[string]eml.MailImportContext{"labelled@example.com": labelled, "archived@example.com": archived}

	if _, err := runOnce(t, config, "bank-test", importer(false)); err == nil {
		t.Fatal("unavailable Bank reported as success")
	}
	if !reflect.DeepEqual(observed, want) {
		t.Fatalf("fresh upload contexts = %+v", observed)
	}
	clear(observed)
	result, err := runOnce(t, config, "bank-test", importer(true))
	if err != nil || result.Fetched != 0 || result.Inserted != 2 {
		t.Fatalf("queued retry = %+v, %v", result, err)
	}
	if !reflect.DeepEqual(observed, want) {
		t.Fatalf("queued upload contexts = %+v", observed)
	}
}

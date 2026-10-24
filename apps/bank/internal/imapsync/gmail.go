package imapsync

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"strconv"
	"strings"
	"time"

	gmailimap "github.com/emersion/go-imap"
	gmailclient "github.com/emersion/go-imap/client"
	"github.com/emersion/go-imap/utf7"
	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-sasl"

	"github.com/aquitano/aqt/apps/bank/internal/eml"
)

const gmailExtension imap.Cap = "X-GM-EXT-1"

// specialUseLabels maps the special-use attribute of a Gmail folder to the
// system label X-GM-LABELS reports for the same folder.
var specialUseLabels = map[string]string{
	`\sent`: `\sent`, `\drafts`: `\draft`, `\flagged`: `\starred`,
	`\important`: `\important`, `\trash`: `\trash`, `\junk`: `\spam`,
}

type gmailMetadata struct {
	ThreadID string   `json:"thread_id"`
	Labels   []string `json:"labels,omitempty"`
}

// gmailSession is a second, read-only connection for the X-GM-EXT-1 FETCH
// items. go-imap v2 can neither request nor parse them and upstream declined
// to add Gmail extensions, while go-imap v1 passes extension items through.
type gmailSession struct {
	client   *gmailclient.Client
	stop     func() bool
	folders  map[string]string
	selected string
}

func (connection *connector) connectGmail(ctx context.Context) (*gmailSession, error) {
	dialer := net.Dialer{Timeout: connection.timeout}
	conn, err := dialer.DialContext(ctx, "tcp", connection.account.Address)
	if err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	timer := time.AfterFunc(connection.timeout, func() { _ = conn.Close() })
	defer timer.Stop()
	gmail := &gmailSession{stop: stop, folders: map[string]string{`\inbox`: "INBOX"}}
	if connection.account.TLS == "starttls" {
		gmail.client, err = gmailclient.New(conn)
		if err == nil {
			err = gmail.client.StartTLS(connection.tls)
		}
	} else {
		encrypted := tls.Client(conn, connection.tls)
		err = encrypted.HandshakeContext(ctx)
		if err == nil {
			gmail.client, err = gmailclient.New(encrypted)
		}
	}
	if err == nil {
		// Commands return their own errors; the default logger would also
		// print one for the reader stopping when close drops the connection.
		gmail.client.ErrorLog = log.New(io.Discard, "", 0)
		err = connection.authenticate(func() bool {
			supported, _ := gmail.client.SupportAuth(sasl.Plain)
			return supported
		}, gmail.client.Authenticate, gmail.client.Login)
	}
	if err == nil {
		gmail.client.Timeout = connection.timeout
		err = gmail.listSpecialUse()
	}
	if err != nil {
		stop()
		_ = conn.Close()
		return nil, fmt.Errorf("Gmail metadata connection: %w", err)
	}
	return gmail, nil
}

func (gmail *gmailSession) close() {
	gmail.stop()
	_ = gmail.client.Terminate()
}

func (gmail *gmailSession) listSpecialUse() error {
	mailboxes := make(chan *gmailimap.MailboxInfo, 16)
	listed := make(chan error, 1)
	go func() { listed <- gmail.client.List("", "*", mailboxes) }()
	for mailbox := range mailboxes {
		for _, attribute := range mailbox.Attributes {
			if label, ok := specialUseLabels[strings.ToLower(attribute)]; ok {
				gmail.folders[label] = mailbox.Name
			}
		}
	}
	return <-listed
}

// annotateGmail attaches each message's Gmail thread ID and labels. Labels
// become the IMAP folder names Gmail exposes for them, so a label and the
// folder collected directly are the same Bank mailbox.
func (session *session) annotateGmail(folder string, validity uint32, messages []messageInfo) error {
	if session.openGmail == nil || len(messages) == 0 {
		return nil
	}
	if session.gmail == nil {
		gmail, err := session.openGmail()
		if err != nil {
			return err
		}
		session.gmail = gmail
	}
	return session.gmail.annotate(folder, validity, messages)
}

func (gmail *gmailSession) annotate(folder string, validity uint32, messages []messageInfo) error {
	if gmail.selected != folder {
		status, err := gmail.client.Select(folder, true)
		if err != nil {
			return err
		}
		if status.UidValidity != validity {
			return fmt.Errorf("Gmail metadata connection saw UIDVALIDITY %d, want %d", status.UidValidity, validity)
		}
		gmail.selected = folder
	}
	set := new(gmailimap.SeqSet)
	set.AddRange(uint32(messages[0].UID), uint32(messages[len(messages)-1].UID))
	fetched := make(chan *gmailimap.Message, 64)
	done := make(chan error, 1)
	go func() {
		done <- gmail.client.UidFetch(set, []gmailimap.FetchItem{gmailimap.FetchUid, "X-GM-THRID", "X-GM-LABELS"}, fetched)
	}()
	found := make(map[imap.UID]gmailMetadata, len(messages))
	var parseErr error
	for message := range fetched {
		metadata, err := gmail.metadata(message)
		if err != nil {
			parseErr = errors.Join(parseErr, fmt.Errorf("UID %d: %w", message.Uid, err))
			continue
		}
		found[imap.UID(message.Uid)] = metadata
	}
	if err := errors.Join(<-done, parseErr); err != nil {
		return err
	}
	for index, message := range messages {
		metadata, ok := found[message.UID]
		if !ok {
			return fmt.Errorf("UID %d: no Gmail thread ID or labels; retrying without advancing checkpoint", message.UID)
		}
		messages[index].Gmail = &metadata
	}
	return nil
}

func (gmail *gmailSession) metadata(message *gmailimap.Message) (gmailMetadata, error) {
	raw, err := gmailimap.ParseString(message.Items["X-GM-THRID"])
	if err != nil {
		return gmailMetadata{}, fmt.Errorf("X-GM-THRID: %w", err)
	}
	thread, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		return gmailMetadata{}, fmt.Errorf("X-GM-THRID: %w", err)
	}
	labels, err := gmailimap.ParseStringList(message.Items["X-GM-LABELS"])
	if err != nil {
		return gmailMetadata{}, fmt.Errorf("X-GM-LABELS: %w", err)
	}
	for index, label := range labels {
		if decoded, err := utf7.Encoding.NewDecoder().String(label); err == nil {
			label = decoded
		}
		if folder, ok := gmail.folders[strings.ToLower(label)]; strings.HasPrefix(label, `\`) && ok {
			label = folder
		}
		labels[index] = label
	}
	return gmailMetadata{ThreadID: eml.GmailThreadID(thread), Labels: labels}, nil
}

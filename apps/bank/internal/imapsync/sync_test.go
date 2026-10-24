package imapsync

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"
	"github.com/emersion/go-imap/v2/imapserver/imapmemserver"
	"github.com/emersion/go-sasl"
	"golang.org/x/oauth2"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/eml"
)

type fixture struct {
	config    Config
	user      *imapmemserver.User
	shutdown  func()
	fetches   atomic.Int64
	metadata  atomic.Int64
	readWrite atomic.Bool
	nonPeek   atomic.Bool
	dropBody  atomic.Bool
	truncate  atomic.Bool
	oauth     atomic.Bool
	bodyReply string
	bodyReady chan struct{}
}

type observedSession struct {
	imapserver.Session
	fixture *fixture
	conn    *imapserver.Conn
}

func (session *observedSession) AuthenticateMechanisms() []string {
	if session.fixture.oauth.Load() {
		return []string{"XOAUTH2"}
	}
	return []string{"PLAIN"}
}

func (session *observedSession) Authenticate(mechanism string) (sasl.Server, error) {
	if mechanism == "XOAUTH2" {
		return &oauthTestServer{session: session.Session}, nil
	}
	return sasl.NewPlainServer(func(_, username, password string) error { return session.Login(username, password) }), nil
}

type oauthTestServer struct {
	session    imapserver.Session
	challenged bool
}

func (server *oauthTestServer) Next(response []byte) ([]byte, bool, error) {
	if server.challenged {
		if len(response) != 0 {
			return nil, false, fmt.Errorf("expected empty response to OAuth error challenge")
		}
		return nil, false, imapserver.ErrAuthFailed
	}
	if string(response) != "user=test@example.com\x01auth=Bearer test-access-token\x01\x01" {
		server.challenged = true
		return []byte(`{"status":"401","schemes":"bearer","scope":"https://mail.google.com/"}`), false, nil
	}
	return nil, true, server.session.Login("test@example.com", "secret")
}

func (session *observedSession) Select(name string, options *imap.SelectOptions) (*imap.SelectData, error) {
	if !options.ReadOnly {
		session.fixture.readWrite.Store(true)
	}
	return session.Session.Select(name, options)
}

func (session *observedSession) Fetch(writer *imapserver.FetchWriter, set imap.NumSet, options *imap.FetchOptions) error {
	if len(options.BodySection) > 0 {
		session.fixture.fetches.Add(1)
		for _, section := range options.BodySection {
			if !section.Peek {
				session.fixture.nonPeek.Store(true)
			}
		}
		if session.fixture.bodyReply != "" {
			_, err := io.WriteString(session.conn.NetConn(), session.fixture.bodyReply)
			if session.fixture.bodyReady != nil {
				close(session.fixture.bodyReady)
			}
			return err
		}
		if session.fixture.dropBody.CompareAndSwap(true, false) {
			return &imap.Error{Type: imap.StatusResponseTypeNo, Text: "temporary FETCH failure"}
		}
		if session.fixture.truncate.CompareAndSwap(true, false) {
			_, _ = io.WriteString(session.conn.NetConn(), "* 1 FETCH (UID 1 BODY[] {1000}\r\npartial")
			_ = session.conn.NetConn().Close()
			return io.ErrUnexpectedEOF
		}
	} else {
		session.fixture.metadata.Add(1)
	}
	return session.Session.Fetch(writer, set, options)
}

type testLiteral struct {
	*bytes.Reader
	size int64
}

func (literal testLiteral) Size() int64 { return literal.size }

func (fixture *fixture) append(tb testing.TB, folder string, raw []byte) {
	tb.Helper()
	_, err := fixture.user.Append(folder, testLiteral{bytes.NewReader(raw), int64(len(raw))}, &imap.AppendOptions{})
	if err != nil {
		tb.Fatal(err)
	}
}

func testTLS(tb testing.TB, dir string) (*tls.Config, string) {
	tb.Helper()
	certServer := httptest.NewTLSServer(http.NotFoundHandler())
	tlsConfig := certServer.TLS.Clone()
	certificate := certServer.Certificate()
	certServer.Close()
	caFile := filepath.Join(dir, "ca.pem")
	if err := os.WriteFile(caFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Raw}), 0o600); err != nil {
		tb.Fatal(err)
	}
	return tlsConfig, caFile
}

func newFixture(tb testing.TB, mode string) *fixture {
	tb.Helper()
	tb.Setenv("BANK_TEST_IMAP_USER", "test@example.com")
	tb.Setenv("BANK_TEST_IMAP_PASSWORD", "secret")
	dir := tb.TempDir()
	tlsConfig, caFile := testTLS(tb, dir)
	backend := imapmemserver.New()
	user := imapmemserver.NewUser("test@example.com", "secret")
	for _, folder := range []string{"INBOX", "Sent"} {
		if err := user.Create(folder, nil); err != nil {
			tb.Fatal(err)
		}
	}
	backend.AddUser(user)
	fixture := &fixture{user: user}
	server := imapserver.New(&imapserver.Options{
		NewSession: func(conn *imapserver.Conn) (imapserver.Session, *imapserver.GreetingData, error) {
			return &observedSession{Session: backend.NewSession(), fixture: fixture, conn: conn}, nil, nil
		},
		TLSConfig: tlsConfig,
		Logger:    log.New(io.Discard, "", 0),
	})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatal(err)
	}
	if mode == "tls" {
		listener = tls.NewListener(listener, tlsConfig)
	}
	served := make(chan error, 1)
	go func() { served <- server.Serve(listener) }()
	var shutdown sync.Once
	fixture.shutdown = func() {
		shutdown.Do(func() {
			_ = listener.Close()
			_ = server.Close()
			<-served
		})
	}
	tb.Cleanup(fixture.shutdown)
	fixture.config = Config{
		StateDir: filepath.Join(dir, "state"), Interval: "1s", Timeout: "5s", Workers: 2, BatchSize: 2, MaxMessageBytes: 1 << 20,
		Accounts: []Account{{ID: "test", Source: "proton", Address: listener.Addr().String(), UsernameEnv: "BANK_TEST_IMAP_USER", PasswordEnv: "BANK_TEST_IMAP_PASSWORD", TLS: mode, CAFile: caFile, Folders: []string{"INBOX"}}},
	}
	return fixture
}

func rawMessage(id string) []byte {
	return []byte("Message-ID: <" + id + "@example.com>\r\nFrom: sender@example.com\r\nTo: test@example.com\r\nDate: Fri, 02 Oct 2026 12:00:00 +0000\r\nSubject: Fixture\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=parts\r\n\r\n--parts\r\nContent-Type: text/plain\r\n\r\nHello from IMAP.\r\n--parts\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=sample.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECAwQ=\r\n--parts--\r\n")
}

func acceptingImporter(context.Context, string, string, eml.MailImportContext) (eml.Result, error) {
	return eml.Result{Inserted: 1, MailContextVersion: 1}, nil
}

func runOnce(tb testing.TB, config Config, destination string, importer Importer) (Result, error) {
	tb.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var result Result
	err := Run(ctx, config, destination, importer, true, func(event Event) {
		if event.Kind != "pass" {
			return
		}
		result.Fetched += event.Result.Fetched
		result.Inserted += event.Result.Inserted
		result.Duplicates += event.Result.Duplicates
		result.Rejected += event.Result.Rejected
		result.Bytes += event.Result.Bytes
	})
	return result, err
}

func readCheckpoint(tb testing.TB, config Config, folder string) checkpoint {
	tb.Helper()
	st, err := openState(config.StateDir)
	if err != nil {
		tb.Fatal(err)
	}
	defer st.close()
	point, err := st.load(context.Background(), config.Accounts[0].ID, folder)
	if err != nil {
		tb.Fatal(err)
	}
	return point
}

func TestSyncHTTPResumeAndUIDValidity(t *testing.T) {
	for _, mode := range []string{"tls", "starttls"} {
		t.Run(mode, func(t *testing.T) {
			fixture := newFixture(t, mode)
			for _, id := range []string{"one", "two", "three"} {
				fixture.append(t, "INBOX", rawMessage(id))
			}
			var mutex sync.Mutex
			stored := make(map[string]bool)
			lostResponse := false
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if request.URL.Path != "/v1/import/eml" || request.URL.Query().Get("source") != "proton" || request.Header.Get("Authorization") != "Bearer test-token" {
					t.Error("incorrect import request")
					http.Error(writer, "bad request", http.StatusBadRequest)
					return
				}
				reader, err := request.MultipartReader()
				if err != nil {
					t.Error(err)
					return
				}
				part, err := reader.NextPart()
				if err != nil {
					t.Error(err)
					return
				}
				var observation eml.MailImportContext
				if part.FormName() != "mail_context" || json.NewDecoder(part).Decode(&observation) != nil || observation.Mailbox != "INBOX" {
					t.Error("missing mailbox context")
					return
				}
				part, err = reader.NextPart()
				if err != nil {
					t.Error(err)
					return
				}
				raw, err := io.ReadAll(part)
				if err != nil {
					t.Error(err)
					return
				}
				message, err := eml.Parse(raw)
				if err != nil {
					t.Error(err)
					return
				}
				if len(message.Attachments) != 1 || !bytes.Equal(message.Attachments[0].Data, []byte{0, 1, 2, 3, 4}) || !strings.Contains(message.Body, "Hello from IMAP.") {
					t.Error("message body or attachment changed")
				}
				mutex.Lock()
				defer mutex.Unlock()
				outcome := eml.Result{Inserted: 1, MailContextVersion: 1}
				if stored[message.MessageID] {
					outcome = eml.Result{Duplicates: 1, MailContextVersion: 1}
				}
				stored[message.MessageID] = true
				if message.MessageID == "three@example.com" && !lostResponse {
					lostResponse = true
					http.Error(writer, "response lost after storing", http.StatusServiceUnavailable)
					return
				}
				_ = json.NewEncoder(writer).Encode(outcome)
			}))
			defer server.Close()
			remote := client.New(server.URL, "test-token")
			importer := func(ctx context.Context, source, path string, observation eml.MailImportContext) (eml.Result, error) {
				return client.ImportFile[eml.Result](ctx, remote, "eml", source, path, &observation)
			}
			if _, err := runOnce(t, fixture.config, server.URL, importer); err == nil {
				t.Fatal("lost HTTP response reported as success")
			}
			if point := readCheckpoint(t, fixture.config, "INBOX"); point.UID != 2 {
				t.Fatalf("checkpoint after failure = %+v, want UID 2", point)
			}
			result, err := runOnce(t, fixture.config, server.URL, importer)
			if err != nil || result.Fetched != 0 || result.Duplicates != 1 {
				t.Fatalf("resume = %+v, %v", result, err)
			}
			before := fixture.fetches.Load()
			beforeMetadata := fixture.metadata.Load()
			result, err = runOnce(t, fixture.config, server.URL, importer)
			if err != nil || result.Fetched != 0 || fixture.fetches.Load() != before || fixture.metadata.Load() != beforeMetadata {
				t.Fatalf("unchanged mailbox fetched again: %+v, %v", result, err)
			}
			if err := fixture.user.Delete("INBOX"); err != nil {
				t.Fatal(err)
			}
			if err := fixture.user.Create("INBOX", nil); err != nil {
				t.Fatal(err)
			}
			fixture.append(t, "INBOX", rawMessage("one"))
			fixture.append(t, "INBOX", rawMessage("four"))
			result, err = runOnce(t, fixture.config, server.URL, importer)
			if err != nil || result.Fetched != 2 || result.Inserted != 1 || result.Duplicates != 1 {
				t.Fatalf("UIDVALIDITY recovery = %+v, %v", result, err)
			}
			if fixture.readWrite.Load() || fixture.nonPeek.Load() {
				t.Fatal("collector used writable SELECT or non-PEEK FETCH")
			}
			statuses, err := ReadStatus(fixture.config.StateDir)
			if err != nil || len(statuses) != 1 || statuses[0].LastSuccess == "" || statuses[0].LastError != "" {
				t.Fatalf("status = %+v, %v", statuses, err)
			}
		})
	}
}

func TestFailedFolderDoesNotBlockOtherFolders(t *testing.T) {
	fixture := newFixture(t, "tls")
	fixture.config.Accounts[0].Folders = []string{"INBOX", "Sent"}
	fixture.append(t, "INBOX", rawMessage("fail"))
	fixture.append(t, "Sent", rawMessage("sent"))
	importer := func(_ context.Context, _, path string, _ eml.MailImportContext) (eml.Result, error) {
		raw, err := os.ReadFile(path)
		if err != nil {
			return eml.Result{}, err
		}
		if bytes.Contains(raw, []byte("fail@example.com")) {
			return eml.Result{}, fmt.Errorf("Bank unavailable")
		}
		return eml.Result{Inserted: 1, MailContextVersion: 1}, nil
	}
	result, err := runOnce(t, fixture.config, "bank-test", importer)
	if err == nil || result.Inserted != 1 {
		t.Fatalf("folder isolation = %+v, %v", result, err)
	}
	if readCheckpoint(t, fixture.config, "INBOX").UID != 0 || readCheckpoint(t, fixture.config, "Sent").UID != 1 {
		t.Fatal("failed folder advanced or healthy folder did not advance")
	}
	statuses, err := ReadStatus(fixture.config.StateDir)
	if err != nil || statuses[0].LastError == "" || statuses[0].LastSuccess != "" {
		t.Fatalf("failure status = %+v, %v", statuses, err)
	}
}

func TestRejectedMessageIsAcknowledged(t *testing.T) {
	fixture := newFixture(t, "tls")
	fixture.append(t, "INBOX", rawMessage("reject"))
	fixture.append(t, "INBOX", rawMessage("after"))
	importer := func(_ context.Context, _, path string, _ eml.MailImportContext) (eml.Result, error) {
		raw, err := os.ReadFile(path)
		if err != nil {
			return eml.Result{}, err
		}
		if bytes.Contains(raw, []byte("reject@example.com")) {
			return eml.Result{Rejected: 1, MailContextVersion: 1}, nil
		}
		return eml.Result{Inserted: 1, MailContextVersion: 1}, nil
	}
	result, err := runOnce(t, fixture.config, "bank-test", importer)
	if err != nil || result.Inserted != 1 || result.Rejected != 1 || readCheckpoint(t, fixture.config, "INBOX").UID != 2 {
		t.Fatalf("rejected message = %+v, %v", result, err)
	}
	statuses, err := ReadStatus(fixture.config.StateDir)
	if err != nil || statuses[0].Pending != 0 || statuses[0].Rejected != 1 || statuses[0].LastError != "" {
		t.Fatalf("rejection status = %+v, %v", statuses, err)
	}
}

func TestMissingContextAcknowledgementKeepsPendingMail(t *testing.T) {
	fixture := newFixture(t, "tls")
	fixture.append(t, "INBOX", rawMessage("pending-context"))
	oldImporter := func(_ context.Context, _ string, path string, observation eml.MailImportContext) (eml.Result, error) {
		if observation.Mailbox != "INBOX" || observation.AccountID != fixture.config.Accounts[0].ID || observation.RelativePath != filepath.Base(path) {
			t.Error("missing queued mail context")
		}
		if observation.Version != 1 || observation.ThreadID != "" || len(observation.Labels) != 0 {
			t.Errorf("server without X-GM-EXT-1 produced context %+v", observation)
		}
		return eml.Result{Inserted: 1}, nil
	}
	if _, err := runOnce(t, fixture.config, "old-bank", oldImporter); err == nil {
		t.Fatal("missing context acknowledgement accepted")
	}
	if readCheckpoint(t, fixture.config, "INBOX").UID != 0 {
		t.Fatal("unacknowledged context advanced checkpoint")
	}
	result, err := runOnce(t, fixture.config, "old-bank", acceptingImporter)
	if err != nil || result.Fetched != 0 || result.Inserted != 1 {
		t.Fatalf("pending retry: %+v %v", result, err)
	}
}

func TestFetchFailureAndOversizedMessageRetainCheckpoint(t *testing.T) {
	fixture := newFixture(t, "tls")
	fixture.append(t, "INBOX", rawMessage("one"))
	fixture.dropBody.Store(true)
	if _, err := runOnce(t, fixture.config, "bank-test", acceptingImporter); err == nil {
		t.Fatal("FETCH failure ignored")
	}
	if readCheckpoint(t, fixture.config, "INBOX").UID != 0 {
		t.Fatal("failed FETCH advanced checkpoint")
	}
	fixture.config.MaxMessageBytes = 10
	if result, err := runOnce(t, fixture.config, "bank-test", acceptingImporter); err == nil || result.Inserted != 0 {
		t.Fatal("oversized message accepted")
	}
	if readCheckpoint(t, fixture.config, "INBOX").UID != 0 {
		t.Fatal("oversized message skipped")
	}
	fixture.config.MaxMessageBytes = 1 << 20
	result, err := runOnce(t, fixture.config, "bank-test", acceptingImporter)
	if err != nil || result.Inserted != 1 {
		t.Fatalf("retry = %+v, %v", result, err)
	}
}

func TestInaccurateReportedSizeIsAccepted(t *testing.T) {
	fixture := newFixture(t, "tls")
	fixture.append(t, "INBOX", rawMessage("one"))
	raw := append([]byte("X-Rewritten: yes\r\n"), rawMessage("one")...)
	fixture.bodyReply = fmt.Sprintf("* 1 FETCH (UID 1 BODY[] {%d}\r\n%s)\r\n", len(raw), raw)
	result, err := runOnce(t, fixture.config, "bank-test", acceptingImporter)
	if err != nil || result.Inserted != 1 || result.Bytes != int64(len(raw)) || readCheckpoint(t, fixture.config, "INBOX").UID != 1 {
		t.Fatalf("inaccurate RFC822.SIZE = %+v, %v", result, err)
	}
}

func TestCheckTLSAndStateOwnership(t *testing.T) {
	fixture := newFixture(t, "starttls")
	mailboxes, err := Check(context.Background(), fixture.config)
	if err != nil || len(mailboxes) != 2 || fixture.fetches.Load() != 0 {
		t.Fatalf("check = %+v, %v", mailboxes, err)
	}
	if _, err := os.Stat(fixture.config.StateDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("check created persistent state")
	}
	caFile := fixture.config.Accounts[0].CAFile
	fixture.config.Accounts[0].CAFile = ""
	if _, err := Check(context.Background(), fixture.config); err == nil {
		t.Fatal("untrusted certificate accepted")
	}
	fixture.config.Accounts[0].CAFile = caFile
	if _, err := runOnce(t, fixture.config, "bank-test", acceptingImporter); err != nil {
		t.Fatal(err)
	}
	if _, err := runOnce(t, fixture.config, "different-bank", acceptingImporter); err == nil {
		t.Fatal("checkpoint reused for another destination")
	}
	st, err := openState(fixture.config.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer st.close()
	if _, err := openState(fixture.config.StateDir); err == nil {
		t.Fatal("two collectors acquired the same state directory")
	}
}

func TestDaemonPollingAndCancellation(t *testing.T) {
	fixture := newFixture(t, "tls")
	fixture.append(t, "INBOX", rawMessage("one"))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := make(chan Event, 4)
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, fixture.config, "bank-test", acceptingImporter, false, func(event Event) {
			if event.Kind == "pass" {
				events <- event
			}
		})
	}()
	for index := range 2 {
		select {
		case event := <-events:
			if event.Error != "" || (index == 0 && event.Result.Inserted != 1) || (index == 1 && event.Result.Fetched != 0) {
				t.Fatalf("event = %+v", event)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("daemon did not poll")
		}
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("shutdown = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("daemon did not stop promptly")
	}
}

func TestConnectionCancellationInterruptsGreeting(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			accepted <- conn
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	connection := &connector{account: Account{Address: listener.Addr().String(), TLS: "starttls"}, timeout: time.Minute, tls: &tls.Config{MinVersion: tls.VersionTLS12}}
	done := make(chan error, 1)
	go func() {
		_, err := connection.connect(ctx)
		done <- err
	}()
	conn := <-accepted
	defer conn.Close()
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("canceled connection succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation did not interrupt greeting")
	}
}

func TestXOAUTH2AuthenticationAndErrorChallenge(t *testing.T) {
	fixture := newFixture(t, "tls")
	fixture.oauth.Store(true)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	connection, err := newConnector(ctx, fixture.config.Accounts[0], 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	connection.tokens = oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "test-access-token"})
	session, err := connection.connect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	session.close()
	connection.tokens = oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "invalid-token"})
	if session, err := connection.connect(ctx); err == nil {
		session.close()
		t.Fatal("invalid OAuth token accepted")
	}
}

func TestTruncatedBodyIsNeverUploaded(t *testing.T) {
	fixture := newFixture(t, "tls")
	fixture.append(t, "INBOX", rawMessage("one"))
	fixture.truncate.Store(true)
	var uploads atomic.Int64
	importer := func(context.Context, string, string, eml.MailImportContext) (eml.Result, error) {
		uploads.Add(1)
		return eml.Result{Inserted: 1, MailContextVersion: 1}, nil
	}
	if _, err := runOnce(t, fixture.config, "bank-test", importer); err == nil {
		t.Fatal("truncated literal accepted")
	}
	if uploads.Load() != 0 || readCheckpoint(t, fixture.config, "INBOX").UID != 0 {
		t.Fatal("truncated message uploaded or checkpoint advanced")
	}
	if result, err := runOnce(t, fixture.config, "bank-test", importer); err != nil || result.Inserted != 1 {
		t.Fatalf("retry = %+v, %v", result, err)
	}
}

func TestBodyDownloadFailuresReleaseConnection(t *testing.T) {
	for _, mode := range []string{"tls", "starttls"} {
		for _, failure := range []string{"cancel", "timeout", "oversized"} {
			t.Run(mode+"/"+failure, func(t *testing.T) {
				fixture := newFixture(t, mode)
				fixture.append(t, "INBOX", rawMessage("one"))
				fixture.config.Timeout = "1s"
				size := int64(1000)
				if failure == "oversized" {
					size = fixture.config.MaxMessageBytes + 1
				}
				fixture.bodyReply = fmt.Sprintf("* 1 FETCH (UID 1 BODY[] {%d}\r\npartial", size)
				fixture.bodyReady = make(chan struct{})
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				var uploads atomic.Int64
				importer := func(context.Context, string, string, eml.MailImportContext) (eml.Result, error) {
					uploads.Add(1)
					return eml.Result{Inserted: 1, MailContextVersion: 1}, nil
				}
				done := make(chan error, 1)
				go func() { done <- Run(ctx, fixture.config, "bank-test", importer, true, nil) }()
				select {
				case <-fixture.bodyReady:
				case <-time.After(5 * time.Second):
					t.Fatal("body download did not start")
				}
				if failure == "cancel" {
					cancel()
				}
				select {
				case err := <-done:
					if err == nil || (failure == "cancel" && !errors.Is(err, context.Canceled)) {
						t.Fatalf("download failure = %v", err)
					}
				case <-time.After(3 * time.Second):
					t.Fatal("download cleanup blocked after terminal read error")
				}
				if uploads.Load() != 0 || readCheckpoint(t, fixture.config, "INBOX").UID != 0 {
					t.Fatal("failed download was uploaded or checkpoint advanced")
				}
			})
		}
	}
}

func TestBodyBeforeUIDAndChangedSequenceMapping(t *testing.T) {
	for _, returnedUID := range []int{1, 2} {
		t.Run(fmt.Sprint(returnedUID), func(t *testing.T) {
			fixture := newFixture(t, "tls")
			raw := rawMessage("one")
			fixture.append(t, "INBOX", raw)
			fixture.bodyReply = fmt.Sprintf("* 1 FETCH (BODY[] {%d}\r\n%s UID %d)\r\n", len(raw), raw, returnedUID)
			var uploads atomic.Int64
			importer := func(_ context.Context, _, path string, _ eml.MailImportContext) (eml.Result, error) {
				body, err := os.ReadFile(path)
				if err != nil || !bytes.Equal(body, raw) {
					return eml.Result{}, fmt.Errorf("unexpected body: %w", err)
				}
				uploads.Add(1)
				return eml.Result{Inserted: 1, MailContextVersion: 1}, nil
			}
			result, err := runOnce(t, fixture.config, "bank-test", importer)
			if returnedUID == 1 {
				if err != nil || result.Inserted != 1 || readCheckpoint(t, fixture.config, "INBOX").UID != 1 {
					t.Fatalf("body before UID = %+v, %v", result, err)
				}
			} else {
				if err == nil || uploads.Load() != 0 || readCheckpoint(t, fixture.config, "INBOX").UID != 0 {
					t.Fatalf("changed sequence mapping was accepted: %+v, %v", result, err)
				}
				fixture.bodyReply = ""
				if result, err := runOnce(t, fixture.config, "bank-test", importer); err != nil || result.Inserted != 1 {
					t.Fatalf("retry after changed mapping = %+v, %v", result, err)
				}
			}
		})
	}
}

func TestBatchPublicationFailureDoesNotQueue(t *testing.T) {
	st, err := openState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.close()
	ctx := context.Background()
	files := []downloaded{{UID: 1, Path: filepath.Join(st.dir, "missing", "message.eml"), Size: 4}}
	if err := st.stage(ctx, "test", "INBOX", 1, files); err == nil {
		t.Fatal("missing staging directory was published")
	}
	queued, point, err := st.queued(ctx, "test", "INBOX")
	if err != nil || len(queued) != 0 || point.UID != 0 {
		t.Fatalf("queue after publication failure = %+v, %+v, %v", queued, point, err)
	}
}

func TestPendingMailSurvivesRestartAndMailboxDeletion(t *testing.T) {
	fixture := newFixture(t, "tls")
	fixture.config.Accounts[0].Folders = []string{"INBOX", "Sent"}
	raw := rawMessage("queued")
	fixture.append(t, "INBOX", raw)
	failing := func(context.Context, string, string, eml.MailImportContext) (eml.Result, error) {
		return eml.Result{}, fmt.Errorf("Bank unavailable")
	}
	if _, err := runOnce(t, fixture.config, "bank-test", failing); err == nil {
		t.Fatal("failed upload ignored")
	}
	statuses, err := ReadStatus(fixture.config.StateDir)
	if err != nil || statuses[0].Pending != 1 {
		t.Fatalf("pending status = %+v, %v", statuses, err)
	}
	if err := fixture.user.Delete("INBOX"); err != nil {
		t.Fatal(err)
	}
	if err := fixture.user.Create("INBOX", nil); err != nil {
		t.Fatal(err)
	}
	importer := func(_ context.Context, _, path string, _ eml.MailImportContext) (eml.Result, error) {
		queued, err := os.ReadFile(path)
		if err != nil {
			return eml.Result{}, err
		}
		if !bytes.Equal(queued, raw) {
			return eml.Result{}, fmt.Errorf("queued message differs from original")
		}
		return eml.Result{Inserted: 1, MailContextVersion: 1}, nil
	}
	result, err := runOnce(t, fixture.config, "bank-test", importer)
	if err != nil || result.Fetched != 0 || result.Inserted != 1 || fixture.fetches.Load() != 1 {
		t.Fatalf("pending recovery = %+v, %v", result, err)
	}
	statuses, err = ReadStatus(fixture.config.StateDir)
	if err != nil || statuses[0].Pending != 0 {
		t.Fatalf("pending after recovery = %+v, %v", statuses, err)
	}
	fixture.append(t, "Sent", raw)
	if _, err := runOnce(t, fixture.config, "bank-test", failing); err == nil {
		t.Fatal("failed Sent upload ignored")
	}
	fixture.shutdown()
	result, err = runOnce(t, fixture.config, "bank-test", importer)
	if err == nil || result.Fetched != 0 || result.Inserted != 1 {
		t.Fatalf("queued Sent upload with IMAP offline = %+v, %v", result, err)
	}
	statuses, err = ReadStatus(fixture.config.StateDir)
	if err != nil || statuses[0].Pending != 0 {
		t.Fatalf("pending after offline upload = %+v, %v", statuses, err)
	}
}

func TestDaemonRetriesAccountsIndependently(t *testing.T) {
	fixture := newFixture(t, "tls")
	fixture.append(t, "INBOX", rawMessage("one"))
	second := fixture.config.Accounts[0]
	second.ID, second.Source = "second", "gmail"
	fixture.config.Accounts = append(fixture.config.Accounts, second)
	var failed atomic.Bool
	importer := func(_ context.Context, source, _ string, _ eml.MailImportContext) (eml.Result, error) {
		if source == "proton" && failed.CompareAndSwap(false, true) {
			return eml.Result{}, fmt.Errorf("temporary upload failure")
		}
		return eml.Result{Inserted: 1, MailContextVersion: 1}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	healthyBeforeRetry := false
	recovered := false
	err := Run(ctx, fixture.config, "bank-test", importer, false, func(event Event) {
		if event.Kind != "pass" {
			return
		}
		if event.Account == "second" && event.Error == "" {
			healthyBeforeRetry = true
		}
		if event.Account == "test" && event.Error == "" && event.Result.Inserted == 1 {
			recovered = healthyBeforeRetry
			cancel()
		}
	})
	if !errors.Is(err, context.Canceled) || !recovered {
		t.Fatalf("independent retry = %v, recovered=%v", err, recovered)
	}
}

func BenchmarkIMAPBackfill(b *testing.B) {
	fixture := newFixture(b, "tls")
	fixture.config.BatchSize = 32
	fixture.config.Workers = 4
	raw := append(rawMessage("benchmark"), bytes.Repeat([]byte("x"), 64<<10)...)
	const count = 128
	b.SetBytes(int64(len(raw) * count))
	b.ReportAllocs()
	b.ResetTimer()
	for iteration := 0; iteration < b.N; iteration++ {
		b.StopTimer()
		for range count {
			fixture.append(b, "INBOX", raw)
		}
		b.StartTimer()
		result, err := runOnce(b, fixture.config, "benchmark", acceptingImporter)
		if err != nil || result.Fetched != count {
			b.Fatalf("backfill = %+v, %v", result, err)
		}
	}
	b.ReportMetric(float64(fixture.fetches.Load())/float64(b.N), "fetches/op")
}

func TestBatchingBoundsFetchCommands(t *testing.T) {
	fixture := newFixture(t, "tls")
	fixture.config.BatchSize = 32
	for index := range 100 {
		fixture.append(t, "INBOX", rawMessage(fmt.Sprint(index)))
	}
	result, err := runOnce(t, fixture.config, "bank-test", acceptingImporter)
	if err != nil || result.Fetched != 100 || fixture.fetches.Load() != 4 || fixture.metadata.Load() != 1 {
		t.Fatalf("batching: %+v, %v, fetches=%d metadata=%d", result, err, fixture.fetches.Load(), fixture.metadata.Load())
	}
}

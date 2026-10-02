package imapsync

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-sasl"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

type connector struct {
	account  Account
	username string
	password string
	tokens   oauth2.TokenSource
	tls      *tls.Config
	timeout  time.Duration
}

type session struct {
	client  *imapclient.Client
	conn    net.Conn
	stop    func() bool
	timeout time.Duration
}

func newConnector(ctx context.Context, account Account, timeout time.Duration) (*connector, error) {
	username, err := requiredEnv(account.UsernameEnv)
	if err != nil {
		return nil, err
	}
	host, _, err := net.SplitHostPort(account.Address)
	if err != nil {
		return nil, err
	}
	if account.ServerName != "" {
		host = account.ServerName
	}
	connection := &connector{
		account: account, username: username, timeout: timeout,
		tls: &tls.Config{MinVersion: tls.VersionTLS12, ServerName: host},
	}
	if account.CAFile != "" {
		certificates, err := os.ReadFile(account.CAFile)
		if err != nil {
			return nil, fmt.Errorf("read IMAP TLS certificate: %w", err)
		}
		roots, err := x509.SystemCertPool()
		if err != nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(certificates) {
			return nil, fmt.Errorf("tls_ca_file contains no PEM certificates")
		}
		connection.tls.RootCAs = roots
	}
	if account.OAuth2 == nil {
		connection.password, err = requiredEnv(account.PasswordEnv)
		return connection, err
	}
	clientID, err := requiredEnv(account.OAuth2.ClientIDEnv)
	if err != nil {
		return nil, err
	}
	clientSecret, err := requiredEnv(account.OAuth2.ClientSecretEnv)
	if err != nil {
		return nil, err
	}
	refreshToken, err := requiredEnv(account.OAuth2.RefreshTokenEnv)
	if err != nil {
		return nil, err
	}
	config := oauth2.Config{ClientID: clientID, ClientSecret: clientSecret, Endpoint: google.Endpoint}
	ctx = context.WithValue(ctx, oauth2.HTTPClient, &http.Client{Timeout: timeout})
	connection.tokens = config.TokenSource(ctx, &oauth2.Token{RefreshToken: refreshToken})
	return connection, nil
}

func (connection *connector) connect(ctx context.Context) (*session, error) {
	dialer := net.Dialer{Timeout: connection.timeout}
	conn, err := dialer.DialContext(ctx, "tcp", connection.account.Address)
	if err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	timer := time.AfterFunc(connection.timeout, func() { _ = conn.Close() })
	defer timer.Stop()
	var client *imapclient.Client
	if connection.account.TLS == "starttls" {
		client, err = imapclient.NewStartTLS(conn, &imapclient.Options{TLSConfig: connection.tls})
	} else {
		encrypted := tls.Client(conn, connection.tls)
		err = encrypted.HandshakeContext(ctx)
		if err == nil {
			client = imapclient.New(encrypted, nil)
		}
	}
	if err == nil {
		err = client.WaitGreeting()
	}
	if err == nil {
		switch {
		case connection.tokens != nil:
			var token *oauth2.Token
			token, err = connection.tokens.Token()
			if err == nil {
				err = client.Authenticate(&xoauth2Client{username: connection.username, token: token.AccessToken})
			}
		case client.Caps().Has(imap.AuthCap(sasl.Plain)):
			err = client.Authenticate(sasl.NewPlainClient("", connection.username, connection.password))
		default:
			err = client.Login(connection.username, connection.password).Wait()
		}
	}
	if err != nil {
		stop()
		_ = conn.Close()
		if client != nil {
			_ = client.Close()
		}
		return nil, err
	}
	return &session{client: client, conn: conn, stop: stop, timeout: connection.timeout}, nil
}

func (session *session) close() {
	session.stop()
	_ = session.conn.Close()
	_ = session.client.Close()
}

func (session *session) deadline() func() {
	timer := time.AfterFunc(session.timeout, func() { _ = session.conn.Close() })
	return func() { timer.Stop() }
}

func (session *session) selectFolder(folder string) (*imap.SelectData, error) {
	stop := session.deadline()
	defer stop()
	return session.client.Select(folder, &imap.SelectOptions{ReadOnly: true}).Wait()
}

type xoauth2Client struct {
	username string
	token    string
}

func (auth *xoauth2Client) Start() (string, []byte, error) {
	return "XOAUTH2", []byte("user=" + auth.username + "\x01auth=Bearer " + auth.token + "\x01\x01"), nil
}

func (auth *xoauth2Client) Next([]byte) ([]byte, error) {
	return []byte{}, nil
}

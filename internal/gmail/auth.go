// Package gmail syncs a Gmail mailbox via the REST API. Messages are fetched
// with format=raw so the archive keeps original RFC 822 bytes; parsing is
// shared with the other mail importers via the eml package.
//
// Setup: create an OAuth client ("Desktop app") in Google Cloud Console with
// the gmail.readonly scope and put the downloaded JSON at
// <dataDir>/gmail/client_secret.json, then run `bank auth gmail`.
package gmail

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

const scope = "https://www.googleapis.com/auth/gmail.readonly"

func secretPath(dataDir string) string { return filepath.Join(dataDir, "gmail", "client_secret.json") }
func tokenPath(dataDir string) string  { return filepath.Join(dataDir, "gmail", "token.json") }

func loadOAuthConfig(dataDir string) (*oauth2.Config, error) {
	raw, err := os.ReadFile(secretPath(dataDir))
	if err != nil {
		return nil, fmt.Errorf("no OAuth client credentials: %w\n(create a Desktop-app OAuth client in Google Cloud Console and save its JSON there)", err)
	}
	var f struct {
		Installed *struct{ ClientID, ClientSecret string } `json:"installed"`
		Web       *struct{ ClientID, ClientSecret string } `json:"web"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("%s: %w", secretPath(dataDir), err)
	}
	c := f.Installed
	if c == nil {
		c = f.Web
	}
	if c == nil || c.ClientID == "" {
		return nil, fmt.Errorf("%s: expected an \"installed\" OAuth client", secretPath(dataDir))
	}
	return &oauth2.Config{
		ClientID:     c.ClientID,
		ClientSecret: c.ClientSecret,
		Endpoint:     google.Endpoint,
		Scopes:       []string{scope},
	}, nil
}

// Authorize runs the loopback OAuth flow and saves the refresh token.
// port 0 picks a random port; pass a fixed one when tunnelling via
// `ssh -L port:127.0.0.1:port` to authorize a headless box from a laptop.
func Authorize(ctx context.Context, dataDir string, port int) error {
	cfg, err := loadOAuthConfig(dataDir)
	if err != nil {
		return err
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return err
	}
	defer ln.Close()
	cfg.RedirectURL = fmt.Sprintf("http://%s/", ln.Addr().String())

	stateBytes := make([]byte, 16)
	rand.Read(stateBytes)
	state := hex.EncodeToString(stateBytes)
	verifier := oauth2.GenerateVerifier()

	url := cfg.AuthCodeURL(state, oauth2.AccessTypeOffline,
		oauth2.S256ChallengeOption(verifier), oauth2.SetAuthURLParam("prompt", "consent"))
	fmt.Printf("Open this URL in a browser on the machine running this command:\n\n  %s\n\nWaiting for Google to redirect back...\n", url)

	type outcome struct {
		code string
		err  error
	}
	ch := make(chan outcome, 1)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("state") != state {
			http.Error(w, "state mismatch", http.StatusBadRequest)
			return
		}
		if e := q.Get("error"); e != "" {
			fmt.Fprintln(w, "Authorization failed; you can close this tab.")
			ch <- outcome{err: fmt.Errorf("authorization denied: %s", e)}
			return
		}
		fmt.Fprintln(w, "Authorized. You can close this tab and return to the terminal.")
		ch <- outcome{code: q.Get("code")}
	})}
	go srv.Serve(ln)
	defer srv.Close()

	var o outcome
	select {
	case o = <-ch:
	case <-ctx.Done():
		return ctx.Err()
	}
	if o.err != nil {
		return o.err
	}
	tok, err := cfg.Exchange(ctx, o.code, oauth2.VerifierOption(verifier))
	if err != nil {
		return err
	}
	if err := saveToken(dataDir, tok); err != nil {
		return err
	}
	fmt.Println("Token saved to", tokenPath(dataDir))
	return nil
}

func saveToken(dataDir string, tok *oauth2.Token) error {
	raw, err := json.Marshal(tok)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(tokenPath(dataDir)), 0o755); err != nil {
		return err
	}
	return os.WriteFile(tokenPath(dataDir), raw, 0o600)
}

// persistingSource re-saves the token whenever Google rotates it.
type persistingSource struct {
	dataDir string
	src     oauth2.TokenSource

	mu   sync.Mutex
	last string
}

func (p *persistingSource) Token() (*oauth2.Token, error) {
	tok, err := p.src.Token()
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if tok.AccessToken != p.last {
		p.last = tok.AccessToken
		if err := saveToken(p.dataDir, tok); err != nil {
			return nil, err
		}
	}
	return tok, nil
}

func httpClient(ctx context.Context, dataDir string) (*http.Client, error) {
	cfg, err := loadOAuthConfig(dataDir)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(tokenPath(dataDir))
	if err != nil {
		return nil, fmt.Errorf("not authorized yet — run `bank auth gmail` first (%w)", err)
	}
	var tok oauth2.Token
	if err := json.Unmarshal(raw, &tok); err != nil {
		return nil, err
	}
	src := &persistingSource{dataDir: dataDir, src: cfg.TokenSource(ctx, &tok), last: tok.AccessToken}
	return oauth2.NewClient(ctx, src), nil
}

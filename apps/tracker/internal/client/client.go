// Package client is the CLI's side of the HTTP API. Reads go over HTTP
// rather than straight to Postgres so the same commands work against a
// server on another machine, where the database is not reachable at all.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"github.com/aquitano/aqt/apps/tracker/internal/store"
)

type Config struct {
	ServerURL string
	Issuer    string
	ClientID  string
	TokenPath string
}

func (c Config) Authenticated() bool { return c.Issuer != "" }

// session is what login leaves behind: the token plus the endpoints it came
// from, so every later command is one file read instead of a discovery round
// trip.
type session struct {
	Issuer        string        `json:"issuer"`
	ClientID      string        `json:"client_id"`
	DeviceAuthURL string        `json:"device_auth_url"`
	TokenURL      string        `json:"token_url"`
	Token         *oauth2.Token `json:"token"`
}

var ErrSignedOut = errors.New("no stored token: run 'tracker login'")

const discoveryTimeout = 10 * time.Second

func DefaultTokenPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "tracker", "token.json"), nil
}

// Login runs the device authorization grant: this process has no browser, so
// the user approves the code on whatever device does.
func Login(ctx context.Context, c Config, out io.Writer) error {
	if !c.Authenticated() {
		return errors.New("TRACKER_OIDC_ISSUER is not set, so there is nothing to log in to")
	}
	if c.ClientID == "" {
		return errors.New("TRACKER_OIDC_CLIENT_ID is not set")
	}
	cfg, err := oauthConfig(ctx, c)
	if err != nil {
		return err
	}
	device, err := cfg.DeviceAuth(ctx)
	if err != nil {
		return fmt.Errorf("request device code: %w", err)
	}
	if device.VerificationURIComplete != "" {
		fmt.Fprintf(out, "open %s\n", device.VerificationURIComplete)
	}
	fmt.Fprintf(out, "or open %s and enter code %s\n", device.VerificationURI, device.UserCode)
	token, err := cfg.DeviceAccessToken(ctx, device)
	if err != nil {
		return fmt.Errorf("waiting for approval: %w", err)
	}
	s := session{
		Issuer: c.Issuer, ClientID: c.ClientID,
		DeviceAuthURL: cfg.Endpoint.DeviceAuthURL, TokenURL: cfg.Endpoint.TokenURL, Token: token,
	}
	if err := save(c.TokenPath, s); err != nil {
		return err
	}
	fmt.Fprintf(out, "signed in, token stored in %s\n", c.TokenPath)
	return nil
}

func Logout(c Config) error {
	if err := os.Remove(c.TokenPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func oauthConfig(ctx context.Context, c Config) (oauth2.Config, error) {
	provider, err := oidc.NewProvider(oidc.ClientContext(ctx, &http.Client{Timeout: discoveryTimeout}), c.Issuer)
	if err != nil {
		return oauth2.Config{}, fmt.Errorf("discover %s: %w", c.Issuer, err)
	}
	var discovery struct {
		DeviceAuthURL string `json:"device_authorization_endpoint"`
	}
	if err := provider.Claims(&discovery); err != nil {
		return oauth2.Config{}, fmt.Errorf("read discovery document: %w", err)
	}
	if discovery.DeviceAuthURL == "" {
		return oauth2.Config{}, fmt.Errorf("%s publishes no device_authorization_endpoint; enable the device code flow on the provider", c.Issuer)
	}
	return oauth2.Config{
		ClientID: c.ClientID,
		Endpoint: oauth2.Endpoint{DeviceAuthURL: discovery.DeviceAuthURL, TokenURL: provider.Endpoint().TokenURL},
		Scopes:   []string{oidc.ScopeOpenID, oidc.ScopeOfflineAccess, "profile", "email"},
	}, nil
}

type Client struct {
	base string
	http *http.Client
}

// New returns a client that refreshes its own token. With no issuer
// configured it is a plain HTTP client, which is what loopback runs on.
func New(ctx context.Context, c Config) (*Client, error) {
	base, err := url.Parse(c.ServerURL)
	if err != nil {
		return nil, fmt.Errorf("TRACKER_SERVER_URL: %w", err)
	}
	if !c.Authenticated() {
		return &Client{base: base.String(), http: http.DefaultClient}, nil
	}
	s, err := load(c.TokenPath)
	if err != nil {
		return nil, err
	}
	if s.Issuer != c.Issuer || s.ClientID != c.ClientID {
		return nil, fmt.Errorf("stored token is for %s, configured issuer is %s: run 'tracker login'", s.Issuer, c.Issuer)
	}
	cfg := oauth2.Config{
		ClientID: c.ClientID,
		Endpoint: oauth2.Endpoint{DeviceAuthURL: s.DeviceAuthURL, TokenURL: s.TokenURL},
	}
	source := &persisting{base: cfg.TokenSource(ctx, s.Token), path: c.TokenPath, session: s}
	return &Client{base: base.String(), http: oauth2.NewClient(ctx, source)}, nil
}

// persisting writes refreshed tokens back to disk. oauth2 refreshes in
// memory, and authentik can rotate the refresh token, so dropping the new one
// would mean logging in again on the next run.
type persisting struct {
	base    oauth2.TokenSource
	path    string
	session session
}

func (p *persisting) Token() (*oauth2.Token, error) {
	token, err := p.base.Token()
	if err != nil {
		return nil, fmt.Errorf("%w (the refresh token may have expired or been revoked)", err)
	}
	if p.session.Token == nil || token.AccessToken != p.session.Token.AccessToken {
		p.session.Token = token
		if err := save(p.path, p.session); err != nil {
			return nil, err
		}
	}
	return token, nil
}

func load(path string) (session, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return session{}, ErrSignedOut
	}
	if err != nil {
		return session{}, err
	}
	var s session
	if err := json.Unmarshal(raw, &s); err != nil {
		return session{}, fmt.Errorf("%s: %w", path, err)
	}
	if s.Token == nil {
		return session{}, ErrSignedOut
	}
	return s, nil
}

func save(path string, s session) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	// Write and rename: a crash mid-write would otherwise leave a truncated
	// file that only `tracker logout` clears, and a fresh 0600 temp file also
	// tightens the permissions of a session written before this.
	tmp, err := os.CreateTemp(filepath.Dir(path), ".token-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func (c *Client) Search(ctx context.Context, o store.SearchOpts) ([]store.Hit, error) {
	q := url.Values{"q": {o.Query}, "limit": {strconv.Itoa(o.Limit)}}
	if o.Extractor != "" {
		q.Set("extractor", o.Extractor)
	}
	var reply struct {
		Hits []store.Hit `json:"hits"`
	}
	err := c.get(ctx, "/v1/search?"+q.Encode(), &reply)
	return reply.Hits, err
}

type PageVisits struct {
	URL    string       `json:"url"`
	Visits store.Visits `json:"visits"`
}

func (c *Client) Visits(ctx context.Context, pageURL string) (PageVisits, error) {
	var page PageVisits
	err := c.get(ctx, "/v1/visits?"+url.Values{"url": {pageURL}}.Encode(), &page)
	return page, err
}

func (c *Client) Record(ctx context.Context, id int64) (store.RecordDetail, error) {
	var rec store.RecordDetail
	err := c.get(ctx, "/v1/records/"+strconv.FormatInt(id, 10), &rec)
	return rec, err
}

func (c *Client) Time(ctx context.Context, o store.TimeOpts) ([]store.TimeRow, error) {
	q := url.Values{"from": {o.From.UTC().Format(time.RFC3339)}, "to": {o.To.UTC().Format(time.RFC3339)}, "by": {o.By}}
	var reply struct {
		Rows []store.TimeRow `json:"rows"`
	}
	err := c.get(ctx, "/v1/time?"+q.Encode(), &reply)
	return reply.Rows, err
}

func (c *Client) Forget(ctx context.Context, t store.ForgetTarget) (store.Forgotten, error) {
	var forgotten store.Forgotten
	err := c.post(ctx, "/v1/forget", t, &forgotten)
	return forgotten, err
}

func (c *Client) Stats(ctx context.Context) (store.Stats, error) {
	var stats store.Stats
	err := c.get(ctx, "/v1/stats", &stats)
	return stats, err
}

func (c *Client) get(ctx context.Context, path string, into any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return err
	}
	return c.do(req, into)
}

func (c *Client) post(ctx context.Context, path string, body, into any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	return c.do(req, into)
}

func (c *Client) do(req *http.Request, into any) error {
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%s: %w", c.base, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return httpError(req.URL.String(), res)
	}
	if err := json.NewDecoder(res.Body).Decode(into); err != nil {
		return fmt.Errorf("%s: %w", req.URL.RequestURI(), err)
	}
	return nil
}

func httpError(target string, res *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(res.Body, 2<<10))
	var reply struct {
		Error string `json:"error"`
	}
	msg := string(body)
	if json.Unmarshal(body, &reply) == nil && reply.Error != "" {
		msg = reply.Error
	}
	if res.StatusCode == http.StatusUnauthorized {
		return fmt.Errorf("%s: %s (run 'tracker login')", target, msg)
	}
	return fmt.Errorf("%s: HTTP %d %s", target, res.StatusCode, msg)
}

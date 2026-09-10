// Package auth verifies OIDC bearer tokens against the issuer's published
// keys. An empty issuer turns it off, which is what loopback development and
// the tests run on; everything else is a hard failure at startup rather than
// a server that silently accepts anything.
package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

// An issuer that accepts the connection and then says nothing would otherwise
// hang startup before the listener binds, which launchd cannot tell from a
// healthy process. The client is kept for later key-set refreshes too.
const httpTimeout = 10 * time.Second

type Config struct {
	Issuer   string
	Audience string
}

func (c Config) Enabled() bool { return c.Issuer != "" }

type Authenticator struct {
	verifier *oidc.IDTokenVerifier
}

var ErrNoToken = errors.New("auth: no bearer token")

// New returns an Authenticator that accepts everything when the issuer is
// empty. Discovery happens here, so an unreachable issuer stops the server
// instead of failing every request later.
func New(ctx context.Context, c Config) (*Authenticator, error) {
	if !c.Enabled() {
		return &Authenticator{}, nil
	}
	if c.Audience == "" {
		return nil, errors.New("auth: an issuer needs an audience, or any token from that issuer is accepted")
	}
	provider, err := oidc.NewProvider(oidc.ClientContext(ctx, &http.Client{Timeout: httpTimeout}), c.Issuer)
	if err != nil {
		return nil, fmt.Errorf("auth: discover %s: %w", c.Issuer, err)
	}
	return &Authenticator{verifier: provider.Verifier(&oidc.Config{ClientID: c.Audience})}, nil
}

// Off accepts every request, for loopback and for tests.
func Off() *Authenticator { return &Authenticator{} }

func (a *Authenticator) Enabled() bool { return a.verifier != nil }

// Verify reports whether the request carries a token this issuer signed.
func (a *Authenticator) Verify(ctx context.Context, r *http.Request) error {
	if !a.Enabled() {
		return nil
	}
	token := bearer(r.Header.Get("Authorization"))
	if token == "" {
		return ErrNoToken
	}
	if _, err := a.verifier.Verify(ctx, token); err != nil {
		return fmt.Errorf("auth: %w", err)
	}
	return nil
}

func bearer(header string) string {
	const prefix = "bearer "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}

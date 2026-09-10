package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/tracker/internal/authtest"
)

const audience = "tracker"

func request(t *testing.T, token string) *http.Request {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/v1/search", nil)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	return r
}

func TestVerify(t *testing.T) {
	ctx := context.Background()
	iss := authtest.NewIssuer(t)
	a, err := New(ctx, Config{Issuer: iss.URL, Audience: audience})
	if err != nil {
		t.Fatal(err)
	}

	if err := a.Verify(ctx, request(t, iss.Token(t, audience))); err != nil {
		t.Fatalf("valid token rejected: %v", err)
	}

	if err := a.Verify(ctx, request(t, "")); !errors.Is(err, ErrNoToken) {
		t.Fatalf("missing token: want ErrNoToken, got %v", err)
	}

	if err := a.Verify(ctx, request(t, iss.Token(t, "someone-else"))); err == nil {
		t.Fatal("token for another audience was accepted")
	}

	expired := iss.Claims(audience)
	expired["exp"] = time.Now().Add(-time.Minute).Unix()
	if err := a.Verify(ctx, request(t, iss.Sign(t, expired))); err == nil {
		t.Fatal("expired token was accepted")
	}

	if err := a.Verify(ctx, request(t, authtest.NewIssuer(t).Token(t, audience))); err == nil {
		t.Fatal("token signed by an unknown key was accepted")
	}
}

func TestDisabledAcceptsEverything(t *testing.T) {
	ctx := context.Background()
	a, err := New(ctx, Config{})
	if err != nil {
		t.Fatal(err)
	}
	if a.Enabled() {
		t.Fatal("an empty issuer should leave auth off")
	}
	if err := a.Verify(ctx, request(t, "")); err != nil {
		t.Fatalf("auth is off, an unauthenticated request should pass: %v", err)
	}
	if Off().Enabled() {
		t.Fatal("Off should leave auth off")
	}
}

func TestIssuerWithoutAudienceIsRefused(t *testing.T) {
	if _, err := New(context.Background(), Config{Issuer: "https://auth.example"}); err == nil {
		t.Fatal("an issuer without an audience should not start")
	}
}

package client

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/oauth2"
)

func testSession(issuer string) session {
	return session{
		Issuer: issuer, ClientID: "tracker",
		DeviceAuthURL: issuer + "/device", TokenURL: issuer + "/token",
		Token: &oauth2.Token{AccessToken: "access", RefreshToken: "refresh"},
	}
}

func TestSessionRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config", "token.json")
	want := testSession("https://auth.example")
	if err := save(path, want); err != nil {
		t.Fatal(err)
	}

	// The file carries a refresh token: anything wider than the owner is a leak.
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("permissions %o, want 600", perm)
	}

	got, err := load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.Issuer != want.Issuer || got.TokenURL != want.TokenURL {
		t.Errorf("endpoints did not survive: %+v", got)
	}
	if got.Token.AccessToken != "access" || got.Token.RefreshToken != "refresh" {
		t.Errorf("token did not survive: %+v", got.Token)
	}
}

func TestSaveOverAWiderFileTightensIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token.json")
	if err := os.WriteFile(path, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := save(path, testSession("https://auth.example")); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("permissions %o, want 600", perm)
	}
}

func TestLoadWithoutAFileIsSignedOut(t *testing.T) {
	if _, err := load(filepath.Join(t.TempDir(), "token.json")); !errors.Is(err, ErrSignedOut) {
		t.Fatalf("want ErrSignedOut, got %v", err)
	}
}

// A token minted for one issuer must not be sent to another, and the fix is a
// login rather than a confusing 401 from the server.
func TestNewRefusesASessionFromAnotherIssuer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token.json")
	if err := save(path, testSession("https://old.example")); err != nil {
		t.Fatal(err)
	}
	_, err := New(context.Background(), Config{
		ServerURL: "http://127.0.0.1:8490",
		Issuer:    "https://new.example",
		ClientID:  "tracker",
		TokenPath: path,
	})
	if err == nil {
		t.Fatal("a session for another issuer was accepted")
	}
}

func TestNewWithoutAnIssuerNeedsNoToken(t *testing.T) {
	c, err := New(context.Background(), Config{
		ServerURL: "http://127.0.0.1:8490",
		TokenPath: filepath.Join(t.TempDir(), "token.json"),
	})
	if err != nil {
		t.Fatalf("auth is off, the CLI should work without a login: %v", err)
	}
	if c.base != "http://127.0.0.1:8490" {
		t.Errorf("base = %q", c.base)
	}
}

// The agent runs unattended for weeks: a spent token must come back refreshed,
// and the rotated refresh token must reach the file or the next run is
// signed out.
func TestBearerRefreshesASpentTokenAndStoresTheRotatedOne(t *testing.T) {
	issuer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil || r.PostForm.Get("refresh_token") != "refresh" {
			http.Error(w, "unexpected refresh", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"access_token":"fresh","refresh_token":"rotated","token_type":"Bearer","expires_in":3600}`))
	}))
	defer issuer.Close()
	path := filepath.Join(t.TempDir(), "token.json")
	spent := testSession(issuer.URL)
	spent.Token.Expiry = time.Now().Add(-time.Minute)
	if err := save(path, spent); err != nil {
		t.Fatal(err)
	}

	bearer, err := Bearer(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if bearer != "fresh" {
		t.Errorf("bearer = %q, want the refreshed token", bearer)
	}
	stored, err := load(path)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Token.RefreshToken != "rotated" {
		t.Errorf("stored refresh token = %q, want the rotated one", stored.Token.RefreshToken)
	}
}

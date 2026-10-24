package api

import (
	"path/filepath"
	"testing"
)

func TestTokensVerifyUntilRevoked(t *testing.T) {
	tokens := Tokens{Path: filepath.Join(t.TempDir(), "attic", "tokens")}
	token, err := tokens.New("executor")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tokens.New("executor"); err == nil {
		t.Fatal("a second token with the same name was minted")
	}
	for presented, want := range map[string]bool{token: true, token + "x": false, "": false} {
		if ok, err := tokens.Verify(presented); err != nil || ok != want {
			t.Errorf("Verify(%q) = %v, %v; want %v", presented, ok, err, want)
		}
	}
	if err := tokens.Revoke("executor"); err != nil {
		t.Fatal(err)
	}
	if ok, err := tokens.Verify(token); err != nil || ok {
		t.Fatalf("revoked token still verifies: %v, %v", ok, err)
	}
}

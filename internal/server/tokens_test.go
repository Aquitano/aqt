package server

import (
	"os"
	"strings"
	"testing"
)

func TestTokenLifecycle(t *testing.T) {
	dir := t.TempDir()

	token, err := NewToken(dir, "laptop")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(token, "bank_") || len(token) != len("bank_")+64 {
		t.Fatalf("unexpected token format %q", token)
	}
	if data, err := os.ReadFile(TokensPath(dir)); err != nil {
		t.Fatal(err)
	} else if strings.Contains(string(data), token) {
		t.Fatal("tokens file stores the plaintext token")
	}
	if info, err := os.Stat(TokensPath(dir)); err != nil {
		t.Fatal(err)
	} else if info.Mode().Perm() != 0o600 {
		t.Fatalf("tokens file mode = %v, want 0600", info.Mode().Perm())
	}

	if _, err := NewToken(dir, "laptop"); err == nil {
		t.Fatal("duplicate name accepted")
	}
	second, err := NewToken(dir, "phone")
	if err != nil {
		t.Fatal(err)
	}

	if !VerifyToken(dir, token) || !VerifyToken(dir, second) {
		t.Fatal("issued token rejected")
	}
	if VerifyToken(dir, token+"x") || VerifyToken(dir, "") || VerifyToken(dir, "bank_deadbeef") {
		t.Fatal("wrong token accepted")
	}

	names, err := ListTokens(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 2 || names[0] != "laptop" || names[1] != "phone" {
		t.Fatalf("ListTokens = %v", names)
	}

	if err := RevokeToken(dir, "laptop"); err != nil {
		t.Fatal(err)
	}
	if VerifyToken(dir, token) {
		t.Fatal("revoked token still verifies")
	}
	if !VerifyToken(dir, second) {
		t.Fatal("revoke dropped the wrong token")
	}
	if err := RevokeToken(dir, "laptop"); err == nil {
		t.Fatal("revoking an unknown name should fail")
	}
}

func TestVerifyTokenWithoutTokensFile(t *testing.T) {
	if VerifyToken(t.TempDir(), "bank_whatever") {
		t.Fatal("verified against a missing tokens file")
	}
}

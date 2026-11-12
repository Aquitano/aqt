package tokens

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func TestTokensVerifyUntilRevoked(t *testing.T) {
	tokens := Store{Path: filepath.Join(t.TempDir(), "app", "tokens"), Prefix: "app_"}
	token, err := tokens.New("executor", Scope{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(token, "app_") {
		t.Fatalf("token %q lacks its prefix", token)
	}
	if data, err := os.ReadFile(tokens.Path); err != nil {
		t.Fatal(err)
	} else if strings.Contains(string(data), token) {
		t.Fatal("the file stores the plaintext token")
	}
	if info, err := os.Stat(tokens.Path); err != nil {
		t.Fatal(err)
	} else if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("file mode = %v, want 0600", info.Mode().Perm())
	}
	if _, err := tokens.New("executor", Scope{}); err == nil {
		t.Fatal("a second token with the same name was minted")
	}
	for presented, want := range map[string]bool{token: true, token + "x": false, "": false} {
		if _, ok, err := tokens.Verify(presented); err != nil || ok != want {
			t.Errorf("Verify(%q) = %v, %v; want %v", presented, ok, err, want)
		}
	}
	if err := tokens.Revoke("executor"); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := tokens.Verify(token); err != nil || ok {
		t.Fatalf("revoked token still verifies: %v, %v", ok, err)
	}
	if err := tokens.Revoke("executor"); err == nil {
		t.Fatal("revoking an unknown name succeeded")
	}
}

func TestScopeLimitsWritesAndDomains(t *testing.T) {
	tokens := Store{Path: filepath.Join(t.TempDir(), "tokens")}
	// A line written before scopes existed opens everything.
	if err := os.WriteFile(tokens.Path, []byte("old:"+hashToken("legacy")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	reader, err := tokens.New("agent", Scope{ReadOnly: true, Domains: []string{"attic"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tokens.New("bad", Scope{Domains: []string{"read"}}); err == nil {
		t.Fatal("a domain named like the read-only grant was accepted")
	}
	for _, tc := range []struct {
		token, domain string
		write, want   bool
	}{
		{"legacy", "bank", true, true},
		{reader, "attic", false, true},
		{reader, "attic", true, false},
		{reader, "bank", false, false},
	} {
		scope, ok, err := tokens.Verify(tc.token)
		if err != nil || !ok {
			t.Fatalf("Verify: %v, %v", ok, err)
		}
		if got := scope.Allows(tc.domain, tc.write); got != tc.want {
			t.Errorf("scope %q allows %s write=%v: %v, want %v", scope, tc.domain, tc.write, got, tc.want)
		}
	}
}

func TestVerifyWithoutFile(t *testing.T) {
	tokens := Store{Path: filepath.Join(t.TempDir(), "tokens")}
	if _, ok, err := tokens.Verify("app_whatever"); err != nil || ok {
		t.Fatalf("Verify against a missing file = %v, %v", ok, err)
	}
}

func TestConcurrentTokenCommandsKeepEveryChange(t *testing.T) {
	tokens := Store{Path: filepath.Join(t.TempDir(), "app", "tokens")}
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Go(func() {
			if _, err := tokens.New(fmt.Sprintf("client-%d", i), Scope{}); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if listed, err := tokens.List(); err != nil || len(listed) != 20 {
		t.Fatalf("%d of 20 concurrently minted tokens kept: %v", len(listed), err)
	}
}

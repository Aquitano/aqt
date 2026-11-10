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
	token, err := tokens.New("executor")
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
	if err := tokens.Revoke("executor"); err == nil {
		t.Fatal("revoking an unknown name succeeded")
	}
}

func TestVerifyWithoutFile(t *testing.T) {
	tokens := Store{Path: filepath.Join(t.TempDir(), "tokens")}
	if ok, err := tokens.Verify("app_whatever"); err != nil || ok {
		t.Fatalf("Verify against a missing file = %v, %v", ok, err)
	}
}

func TestConcurrentTokenCommandsKeepEveryChange(t *testing.T) {
	tokens := Store{Path: filepath.Join(t.TempDir(), "app", "tokens")}
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Go(func() {
			if _, err := tokens.New(fmt.Sprintf("client-%d", i)); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if names, err := tokens.Names(); err != nil || len(names) != 20 {
		t.Fatalf("%d of 20 concurrently minted tokens kept: %v", len(names), err)
	}
}

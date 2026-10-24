package api

import (
	"fmt"
	"path/filepath"
	"sync"
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

func TestConcurrentTokenCommandsKeepEveryChange(t *testing.T) {
	tokens := Tokens{Path: filepath.Join(t.TempDir(), "attic", "tokens")}
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

package gmail

import (
	"encoding/json"
	"os"
	"runtime"
	"testing"

	"golang.org/x/oauth2"
)

func TestSaveTokenRestrictsExistingPermissions(t *testing.T) {
	dir := t.TempDir()
	if err := saveToken(dir, &oauth2.Token{RefreshToken: "old-refresh-token"}); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(tokenPath(dir), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := saveToken(dir, &oauth2.Token{RefreshToken: "new-refresh-token"}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(tokenPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("refreshed token mode = %v, want 0600", info.Mode().Perm())
	}
	raw, err := os.ReadFile(tokenPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	var token oauth2.Token
	if err := json.Unmarshal(raw, &token); err != nil {
		t.Fatal(err)
	}
	if token.RefreshToken != "new-refresh-token" {
		t.Fatal("replacement did not save the refreshed token")
	}
}

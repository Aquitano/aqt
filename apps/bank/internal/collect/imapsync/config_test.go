package imapsync

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestConfigValidationAndRelativePaths(t *testing.T) {
	base := `{"accounts":[{"id":"proton","source":"proton","address":"127.0.0.1:1143","username_env":"USER","password_env":"PASSWORD","tls":"starttls","tls_ca_file":"bridge.pem","folders":["INBOX"]}]}`
	dir := t.TempDir()
	path := filepath.Join(dir, "imap.json")
	if err := os.WriteFile(path, []byte(base), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if config.StateDir != filepath.Join(dir, "imap-state") || config.Accounts[0].CAFile != filepath.Join(dir, "bridge.pem") || config.Workers != 4 {
		t.Fatalf("resolved config = %+v", config)
	}
	for name, change := range map[string]func(*Config){
		"plaintext":          func(config *Config) { config.Accounts[0].TLS = "none" },
		"no folders":         func(config *Config) { config.Accounts[0].Folders = nil },
		"duplicate folders":  func(config *Config) { config.Accounts[0].Folders = []string{"INBOX", "inbox"} },
		"duplicate accounts": func(config *Config) { config.Accounts = append(config.Accounts, config.Accounts[0]) },
		"source traversal":   func(config *Config) { config.Accounts[0].Source = "../other" },
		"unbounded workers":  func(config *Config) { config.Workers = 1000 },
		"zero interval":      func(config *Config) { config.Interval = "0s" },
		"unbounded message":  func(config *Config) { config.MaxMessageBytes = 1 << 40 },
		"ambiguous auth":     func(config *Config) { config.Accounts[0].OAuth2 = &OAuth2{} },
		"invalid address":    func(config *Config) { config.Accounts[0].Address = "mail.example.com" },
	} {
		t.Run(name, func(t *testing.T) {
			config, err := LoadConfig(path)
			if err != nil {
				t.Fatal(err)
			}
			change(&config)
			if err := config.validate(); err == nil {
				t.Fatal("invalid config accepted")
			}
		})
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal([]byte(base), &document); err != nil {
		t.Fatal(err)
	}
	document["workres"] = json.RawMessage("4")
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("unknown config field ignored")
	}
}

func TestRetryBackoffIsBounded(t *testing.T) {
	for failures := range 100 {
		delay := retryDelay(failures)
		if delay < 5*time.Second || delay > 5*time.Minute {
			t.Fatalf("failure %d: delay %v", failures, delay)
		}
	}
}

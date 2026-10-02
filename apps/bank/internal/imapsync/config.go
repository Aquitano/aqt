package imapsync

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
)

type Config struct {
	StateDir        string    `json:"state_dir"`
	Interval        string    `json:"interval"`
	Timeout         string    `json:"timeout"`
	Workers         int       `json:"workers"`
	BatchSize       int       `json:"batch_size"`
	MaxMessageBytes int64     `json:"max_message_bytes"`
	Accounts        []Account `json:"accounts"`
}

type Account struct {
	ID          string   `json:"id"`
	Source      string   `json:"source"`
	Address     string   `json:"address"`
	UsernameEnv string   `json:"username_env"`
	PasswordEnv string   `json:"password_env,omitempty"`
	OAuth2      *OAuth2  `json:"oauth2,omitempty"`
	TLS         string   `json:"tls"`
	CAFile      string   `json:"tls_ca_file,omitempty"`
	ServerName  string   `json:"tls_server_name,omitempty"`
	Folders     []string `json:"folders"`
}

type OAuth2 struct {
	ClientIDEnv     string `json:"client_id_env"`
	ClientSecretEnv string `json:"client_secret_env"`
	RefreshTokenEnv string `json:"refresh_token_env"`
}

func LoadConfig(path string) (Config, error) {
	config := Config{StateDir: "imap-state", Interval: "1m", Timeout: "2m", Workers: 4, BatchSize: 32, MaxMessageBytes: 64 << 20}
	file, err := os.Open(path)
	if err != nil {
		return config, err
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return config, fmt.Errorf("read IMAP config: %w", err)
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); err != io.EOF {
		return config, fmt.Errorf("IMAP config must contain one JSON object")
	}
	base, err := filepath.Abs(filepath.Dir(path))
	if err != nil {
		return config, err
	}
	if config.StateDir == "" {
		return config, fmt.Errorf("state_dir must not be empty")
	}
	if !filepath.IsAbs(config.StateDir) {
		config.StateDir = filepath.Join(base, config.StateDir)
	}
	for index := range config.Accounts {
		account := &config.Accounts[index]
		if account.CAFile != "" && !filepath.IsAbs(account.CAFile) {
			account.CAFile = filepath.Join(base, account.CAFile)
		}
	}
	return config, config.validate()
}

func (config Config) validate() error {
	for name, value := range map[string]string{"interval": config.Interval, "timeout": config.Timeout} {
		duration, err := time.ParseDuration(value)
		if err != nil || duration < time.Second || duration > 24*time.Hour {
			return fmt.Errorf("%s must be a duration between 1s and 24h", name)
		}
	}
	if config.Workers < 1 || config.Workers > 16 || config.BatchSize < 1 || config.BatchSize > 256 {
		return fmt.Errorf("workers must be 1..16 and batch_size must be 1..256")
	}
	if config.MaxMessageBytes < 1 || config.MaxMessageBytes > 512<<20 {
		return fmt.Errorf("max_message_bytes must be 1..536870912")
	}
	if len(config.Accounts) == 0 || len(config.Accounts) > 32 {
		return fmt.Errorf("configure 1..32 accounts")
	}
	seen := make(map[string]bool)
	sources := make(map[string]bool)
	for _, account := range config.Accounts {
		if err := archive.ValidSource(account.ID); err != nil {
			return fmt.Errorf("account id: %w", err)
		}
		if seen[account.ID] {
			return fmt.Errorf("duplicate account id %q", account.ID)
		}
		seen[account.ID] = true
		if sources[account.Source] {
			return fmt.Errorf("each IMAP account needs a distinct source; duplicate %q", account.Source)
		}
		sources[account.Source] = true
		if err := archive.ValidSource(account.Source); err != nil {
			return fmt.Errorf("account %s source: %w", account.ID, err)
		}
		host, port, err := net.SplitHostPort(account.Address)
		portNumber, portErr := strconv.Atoi(port)
		if err != nil || host == "" || portErr != nil || portNumber < 1 || portNumber > 65535 {
			return fmt.Errorf("account %s: address must be host:port", account.ID)
		}
		if account.TLS != "tls" && account.TLS != "starttls" {
			return fmt.Errorf("account %s: tls must be tls or starttls", account.ID)
		}
		if account.UsernameEnv == "" || (account.PasswordEnv == "") == (account.OAuth2 == nil) {
			return fmt.Errorf("account %s: set username_env and exactly one of password_env or oauth2", account.ID)
		}
		if account.OAuth2 != nil && (account.OAuth2.ClientIDEnv == "" || account.OAuth2.ClientSecretEnv == "" || account.OAuth2.RefreshTokenEnv == "") {
			return fmt.Errorf("account %s: oauth2 requires client_id_env, client_secret_env and refresh_token_env", account.ID)
		}
		if len(account.Folders) == 0 {
			return fmt.Errorf("account %s: explicitly select at least one folder", account.ID)
		}
		folders := make(map[string]bool)
		for _, folder := range account.Folders {
			key := folder
			if strings.EqualFold(folder, "INBOX") {
				key = "INBOX"
			}
			if strings.TrimSpace(folder) == "" || strings.ContainsAny(folder, "\r\n\x00") || folders[key] {
				return fmt.Errorf("account %s: empty, invalid or duplicate folder", account.ID)
			}
			folders[key] = true
		}
	}
	return nil
}

func requiredEnv(name string) (string, error) {
	value := os.Getenv(name)
	if value == "" {
		return "", fmt.Errorf("required environment variable %s is empty", name)
	}
	return value, nil
}

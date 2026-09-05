package server

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Tokens live in one line-oriented file, "<name>:<sha256 of the token>", so the
// plaintext token exists only on the client. The file is read per request:
// it is tiny, and revocation then takes effect immediately.

func TokensPath(dataDir string) string { return filepath.Join(dataDir, "tokens") }

type tokenEntry struct {
	Name string
	Hash string
}

func readTokens(dataDir string) ([]tokenEntry, error) {
	data, err := os.ReadFile(TokensPath(dataDir))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []tokenEntry
	for _, line := range strings.Split(string(data), "\n") {
		name, hash, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok || name == "" || hash == "" {
			continue
		}
		out = append(out, tokenEntry{Name: name, Hash: hash})
	}
	return out, nil
}

// writeTokens is atomic: a crash mid-write must not truncate the only record
// of every client's token digest (plaintexts are unrecoverable by design).
func writeTokens(dataDir string, entries []tokenEntry) error {
	var b strings.Builder
	for _, e := range entries {
		fmt.Fprintf(&b, "%s:%s\n", e.Name, e.Hash)
	}
	tmp, err := os.CreateTemp(dataDir, ".tokens-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(b.String()); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), TokensPath(dataDir))
}

// NewToken generates a token for name and stores only its digest. The returned
// plaintext is the only copy — it cannot be recovered later.
func NewToken(dataDir, name string) (string, error) {
	if name == "" || strings.ContainsAny(name, ":\n") {
		return "", fmt.Errorf("invalid token name %q", name)
	}
	entries, err := readTokens(dataDir)
	if err != nil {
		return "", err
	}
	for _, e := range entries {
		if e.Name == name {
			return "", fmt.Errorf("token %q already exists", name)
		}
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	token := "bank_" + hex.EncodeToString(raw[:])
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return "", err
	}
	if err := writeTokens(dataDir, append(entries, tokenEntry{Name: name, Hash: hashToken(token)})); err != nil {
		return "", fmt.Errorf("write tokens: %w", err)
	}
	return token, nil
}

func ListTokens(dataDir string) ([]string, error) {
	entries, err := readTokens(dataDir)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name)
	}
	return names, nil
}

func RevokeToken(dataDir, name string) error {
	entries, err := readTokens(dataDir)
	if err != nil {
		return err
	}
	kept := make([]tokenEntry, 0, len(entries))
	for _, e := range entries {
		if e.Name != name {
			kept = append(kept, e)
		}
	}
	if len(kept) == len(entries) {
		return fmt.Errorf("no token named %q", name)
	}
	return writeTokens(dataDir, kept)
}

// VerifyToken reports whether presented matches a stored token.
func VerifyToken(dataDir, presented string) bool {
	entries, err := readTokens(dataDir)
	if err != nil || len(entries) == 0 || presented == "" {
		return false
	}
	want := []byte(hashToken(presented))
	ok := false
	for _, e := range entries {
		if subtle.ConstantTimeCompare([]byte(e.Hash), want) == 1 {
			ok = true
		}
	}
	return ok
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

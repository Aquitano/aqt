package api

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Tokens live in one line-oriented file, "<name>:<sha256 of the token>", the
// format bank uses, so a plaintext token exists only on its client. The file
// is read per request: it is tiny, and revocation then takes effect at once.
type Tokens struct {
	Path string
}

// DefaultTokens keeps the token file beside attic's configuration.
func DefaultTokens() (Tokens, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return Tokens{}, err
	}
	return Tokens{Path: filepath.Join(dir, "attic", "tokens")}, nil
}

type tokenEntry struct {
	name, hash string
}

func (t Tokens) read() ([]tokenEntry, error) {
	data, err := os.ReadFile(t.Path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []tokenEntry
	for line := range strings.Lines(string(data)) {
		name, hash, ok := strings.Cut(strings.TrimSpace(line), ":")
		if ok && name != "" && hash != "" {
			out = append(out, tokenEntry{name, hash})
		}
	}
	return out, nil
}

// write replaces the file through a rename, so a crash cannot truncate the
// only record of every client's digest.
func (t Tokens) write(entries []tokenEntry) error {
	var b strings.Builder
	for _, e := range entries {
		fmt.Fprintf(&b, "%s:%s\n", e.name, e.hash)
	}
	if err := os.MkdirAll(filepath.Dir(t.Path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(t.Path), ".tokens-*")
	if err != nil {
		return err
	}
	_, err = tmp.WriteString(b.String())
	err = errors.Join(err, tmp.Sync(), tmp.Close())
	if err == nil {
		err = os.Rename(tmp.Name(), t.Path)
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
	}
	return err
}

// New mints a token for name and stores only its digest. The returned
// plaintext is the only copy.
func (t Tokens) New(name string) (string, error) {
	if name == "" || strings.ContainsAny(name, ":\r\n") {
		return "", fmt.Errorf("invalid token name %q", name)
	}
	entries, err := t.read()
	if err != nil {
		return "", err
	}
	for _, e := range entries {
		if e.name == name {
			return "", fmt.Errorf("token %q already exists", name)
		}
	}
	token := "attic_" + rand.Text()
	if err := t.write(append(entries, tokenEntry{name, hashToken(token)})); err != nil {
		return "", fmt.Errorf("write tokens: %w", err)
	}
	return token, nil
}

func (t Tokens) Names() ([]string, error) {
	entries, err := t.read()
	names := make([]string, len(entries))
	for i, e := range entries {
		names[i] = e.name
	}
	return names, err
}

func (t Tokens) Revoke(name string) error {
	entries, err := t.read()
	if err != nil {
		return err
	}
	kept := make([]tokenEntry, 0, len(entries))
	for _, e := range entries {
		if e.name != name {
			kept = append(kept, e)
		}
	}
	if len(kept) == len(entries) {
		return fmt.Errorf("no token named %q", name)
	}
	return t.write(kept)
}

// Verify reports whether presented matches a stored token.
func (t Tokens) Verify(presented string) (bool, error) {
	entries, err := t.read()
	if err != nil || presented == "" {
		return false, err
	}
	want := []byte(hashToken(presented))
	ok := false
	for _, e := range entries {
		if subtle.ConstantTimeCompare([]byte(e.hash), want) == 1 {
			ok = true
		}
	}
	return ok, nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

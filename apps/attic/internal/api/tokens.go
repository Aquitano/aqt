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

	"github.com/gofrs/flock"
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

// update rewrites the file under a lock, so two token commands cannot both
// read the old entries and one undo the other, such as a mint restoring a
// token another command just revoked.
func (t Tokens) update(change func([]tokenEntry) ([]tokenEntry, error)) (err error) {
	if err := os.MkdirAll(filepath.Dir(t.Path), 0o700); err != nil {
		return err
	}
	lock := flock.New(t.Path + ".lock")
	if err := lock.Lock(); err != nil {
		return err
	}
	defer func() { err = errors.Join(err, lock.Unlock()) }()
	entries, err := t.read()
	if err != nil {
		return err
	}
	if entries, err = change(entries); err != nil {
		return err
	}
	return t.write(entries)
}

// New mints a token for name and stores only its digest. The returned
// plaintext is the only copy.
func (t Tokens) New(name string) (string, error) {
	if name == "" || strings.ContainsAny(name, ":\r\n") {
		return "", fmt.Errorf("invalid token name %q", name)
	}
	token := "attic_" + rand.Text()
	err := t.update(func(entries []tokenEntry) ([]tokenEntry, error) {
		for _, e := range entries {
			if e.name == name {
				return nil, fmt.Errorf("token %q already exists", name)
			}
		}
		return append(entries, tokenEntry{name, hashToken(token)}), nil
	})
	if err != nil {
		return "", err
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
	return t.update(func(entries []tokenEntry) ([]tokenEntry, error) {
		kept := make([]tokenEntry, 0, len(entries))
		for _, e := range entries {
			if e.name != name {
				kept = append(kept, e)
			}
		}
		if len(kept) == len(entries) {
			return nil, fmt.Errorf("no token named %q", name)
		}
		return kept, nil
	})
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

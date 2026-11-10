// Package tokens keeps the bearer tokens of an app's HTTP API.
//
// Tokens live in one line-oriented file, "<name>:<sha256 of the token>", so a
// plaintext token exists only on its client. The file is read per request: it
// is tiny, and revocation then takes effect at once.
package tokens

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
	"github.com/natefinch/atomic"
)

type Store struct {
	Path string
	// Prefix starts every minted token, so a leaked one names the app it opens.
	Prefix string
}

type entry struct {
	name, hash string
}

func (s Store) read() ([]entry, error) {
	data, err := os.ReadFile(s.Path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []entry
	for line := range strings.Lines(string(data)) {
		name, hash, ok := strings.Cut(strings.TrimSpace(line), ":")
		if ok && name != "" && hash != "" {
			out = append(out, entry{name, hash})
		}
	}
	return out, nil
}

// update rewrites the file under a lock, so two token commands cannot both
// read the old entries and one undo the other, such as a mint restoring a
// token another command just revoked. The replacement is a rename, so a crash
// cannot truncate the only record of every client's digest.
func (s Store) update(change func([]entry) ([]entry, error)) (err error) {
	if err := os.MkdirAll(filepath.Dir(s.Path), 0o700); err != nil {
		return err
	}
	lock := flock.New(s.Path + ".lock")
	if err := lock.Lock(); err != nil {
		return err
	}
	defer func() { err = errors.Join(err, lock.Unlock()) }()
	entries, err := s.read()
	if err != nil {
		return err
	}
	if entries, err = change(entries); err != nil {
		return err
	}
	var b strings.Builder
	for _, e := range entries {
		fmt.Fprintf(&b, "%s:%s\n", e.name, e.hash)
	}
	return atomic.WriteFile(s.Path, strings.NewReader(b.String()))
}

// New mints a token for name and stores only its digest. The returned
// plaintext is the only copy.
func (s Store) New(name string) (string, error) {
	if name == "" || strings.ContainsAny(name, ":\r\n") {
		return "", fmt.Errorf("invalid token name %q", name)
	}
	token := s.Prefix + rand.Text()
	err := s.update(func(entries []entry) ([]entry, error) {
		for _, e := range entries {
			if e.name == name {
				return nil, fmt.Errorf("token %q already exists", name)
			}
		}
		return append(entries, entry{name, hashToken(token)}), nil
	})
	if err != nil {
		return "", err
	}
	return token, nil
}

func (s Store) Names() ([]string, error) {
	entries, err := s.read()
	names := make([]string, len(entries))
	for i, e := range entries {
		names[i] = e.name
	}
	return names, err
}

func (s Store) Revoke(name string) error {
	return s.update(func(entries []entry) ([]entry, error) {
		kept := make([]entry, 0, len(entries))
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
func (s Store) Verify(presented string) (bool, error) {
	entries, err := s.read()
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

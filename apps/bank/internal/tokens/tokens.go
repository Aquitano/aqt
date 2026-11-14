// Package tokens keeps the bearer tokens of an app's HTTP API.
//
// Tokens live in one line-oriented file, "<name>:<BLAKE3 of the token>:<scope>",
// so a plaintext token exists only on its client. The file is read per
// request: it is tiny, and revocation then takes effect at once.
package tokens

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/gofrs/flock"
	"lukechampine.com/blake3"

	"github.com/aquitano/aqt/apps/bank/internal/atomicfile"
)

type Store struct {
	Path string
	// Prefix starts every minted token, so a leaked one names the app it opens.
	Prefix string
}

// Scope is what a token may do: read, or read and write.
type Scope string

const (
	Read  Scope = "read"
	Write Scope = "write"
)

// Allows reports whether the scope permits an operation that writes or not.
func (s Scope) Allows(writes bool) bool { return s == Write || !writes }

type Token struct {
	Name  string
	Scope Scope
	hash  string
}

func (s Store) read() ([]Token, error) {
	data, err := os.ReadFile(s.Path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Token
	for line := range strings.Lines(string(data)) {
		// A line without a known scope opens nothing.
		name, rest, _ := strings.Cut(strings.TrimSpace(line), ":")
		hash, scope, _ := strings.Cut(rest, ":")
		if name != "" && hash != "" && (Scope(scope) == Read || Scope(scope) == Write) {
			out = append(out, Token{Name: name, Scope: Scope(scope), hash: hash})
		}
	}
	return out, nil
}

// update rewrites the file under a lock, so two token commands cannot both
// read the old entries and one undo the other, such as a mint restoring a
// token another command just revoked. The replacement is a rename, so a crash
// cannot truncate the only record of every client's digest.
func (s Store) update(change func([]Token) ([]Token, error)) (err error) {
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
		b.WriteString(e.Name + ":" + e.hash + ":" + string(e.Scope) + "\n")
	}
	return atomicfile.Write(s.Path, strings.NewReader(b.String()))
}

// New mints a token for name and stores only its digest. The returned
// plaintext is the only copy.
func (s Store) New(name string, scope Scope) (string, error) {
	if name == "" || strings.ContainsAny(name, ":\r\n") {
		return "", fmt.Errorf("invalid token name %q", name)
	}
	if scope != Read && scope != Write {
		return "", fmt.Errorf("invalid token scope %q", scope)
	}
	token := s.Prefix + rand.Text()
	err := s.update(func(entries []Token) ([]Token, error) {
		for _, e := range entries {
			if e.Name == name {
				return nil, fmt.Errorf("token %q already exists", name)
			}
		}
		return append(entries, Token{Name: name, Scope: scope, hash: hashToken(token)}), nil
	})
	if err != nil {
		return "", err
	}
	return token, nil
}

func (s Store) List() ([]Token, error) { return s.read() }

func (s Store) Revoke(name string) error {
	return s.update(func(entries []Token) ([]Token, error) {
		kept := slices.DeleteFunc(slices.Clone(entries), func(e Token) bool { return e.Name == name })
		if len(kept) == len(entries) {
			return nil, fmt.Errorf("no token named %q", name)
		}
		return kept, nil
	})
}

// Verify reports whether presented matches a stored token, and its scope.
func (s Store) Verify(presented string) (Scope, bool, error) {
	entries, err := s.read()
	if err != nil || presented == "" {
		return "", false, err
	}
	want := []byte(hashToken(presented))
	var scope Scope
	ok := false
	for _, e := range entries {
		if subtle.ConstantTimeCompare([]byte(e.hash), want) == 1 {
			scope, ok = e.Scope, true
		}
	}
	return scope, ok, nil
}

func hashToken(token string) string {
	sum := blake3.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

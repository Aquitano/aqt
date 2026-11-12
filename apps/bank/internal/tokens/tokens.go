// Package tokens keeps the bearer tokens of an app's HTTP API.
//
// Tokens live in one line-oriented file, "<name>:<sha256 of the token>" with
// an optional ":<scope>", so a plaintext token exists only on its client. The
// file is read per request: it is tiny, and revocation then takes effect at
// once.
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
	"slices"
	"strings"

	"github.com/gofrs/flock"

	"github.com/aquitano/aqt/apps/bank/internal/atomicfile"
)

type Store struct {
	Path string
	// Prefix starts every minted token, so a leaked one names the app it opens.
	Prefix string
}

// Scope limits what a token opens. The zero value opens everything, which is
// what a line without a scope means.
type Scope struct {
	ReadOnly bool
	// Domains names the APIs the token reaches, such as bank or attic. Empty
	// means every domain.
	Domains []string
}

const readOnly = "read"

func (s Scope) Allows(domain string, write bool) bool {
	return (!write || !s.ReadOnly) && (len(s.Domains) == 0 || slices.Contains(s.Domains, domain))
}

// String is the scope as the file stores it: "read" and the domains, comma
// separated, and empty for a token that opens everything.
func (s Scope) String() string {
	grants := slices.Clone(s.Domains)
	if s.ReadOnly {
		grants = append([]string{readOnly}, grants...)
	}
	return strings.Join(grants, ",")
}

func parseScope(field string) Scope {
	var s Scope
	for grant := range strings.SplitSeq(field, ",") {
		switch grant {
		case "":
		case readOnly:
			s.ReadOnly = true
		default:
			s.Domains = append(s.Domains, grant)
		}
	}
	return s
}

func (s Scope) validate() error {
	for _, domain := range s.Domains {
		if domain == "" || domain == readOnly || strings.ContainsAny(domain, ":,\r\n ") {
			return fmt.Errorf("invalid token domain %q", domain)
		}
	}
	return nil
}

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
		name, rest, ok := strings.Cut(strings.TrimSpace(line), ":")
		hash, scope, _ := strings.Cut(rest, ":")
		if ok && name != "" && hash != "" {
			out = append(out, Token{Name: name, Scope: parseScope(scope), hash: hash})
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
		b.WriteString(e.Name + ":" + e.hash)
		if scope := e.Scope.String(); scope != "" {
			b.WriteString(":" + scope)
		}
		b.WriteByte('\n')
	}
	return atomicfile.Write(s.Path, strings.NewReader(b.String()))
}

// New mints a token for name and stores only its digest. The returned
// plaintext is the only copy.
func (s Store) New(name string, scope Scope) (string, error) {
	if name == "" || strings.ContainsAny(name, ":\r\n") {
		return "", fmt.Errorf("invalid token name %q", name)
	}
	if err := scope.validate(); err != nil {
		return "", err
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
		return Scope{}, false, err
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
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

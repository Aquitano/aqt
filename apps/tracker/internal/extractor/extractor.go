// Package extractor defines what a per-site extractor is and keeps the
// registry both the rules endpoint and the worker read.
package extractor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
)

type Rule struct {
	Extractor string   `json:"extractor"`
	Version   int      `json:"version"`
	Hosts     []string `json:"hosts"`
	PathRegex string   `json:"path_regex"`
	QueryKeys []string `json:"query_keys"`
	DwellMS   int      `json:"dwell_ms"`
	Recapture string   `json:"recapture"`
	MaxBytes  int      `json:"max_bytes"`
}

type Record struct {
	CanonicalURL string
	Title        string
	SearchText   string
	Data         any
}

type Extractor interface {
	Rule() Rule
	Extract(ctx context.Context, html []byte, pageURL *url.URL) (Record, error)
}

// ErrNoMatch means the rule matched but the page held nothing to read: a
// login wall, an empty client-side shell. It is recorded and never retried.
var ErrNoMatch = errors.New("extractor: page has no readable content")

const (
	DefaultDwellMS  = 5000
	DefaultMaxBytes = 10 << 20
	RecaptureNever  = "never"
)

var (
	mu       sync.RWMutex
	registry = map[string]Extractor{}
)

func Register(e Extractor) {
	r := e.Rule()
	if r.Extractor == "" || r.Version < 1 {
		panic(fmt.Sprintf("extractor: rule %+v needs a name and a version >= 1", r))
	}
	if _, err := regexp.Compile(r.PathRegex); err != nil {
		panic(fmt.Sprintf("extractor %s: path_regex: %v", r.Extractor, err))
	}
	mu.Lock()
	defer mu.Unlock()
	if _, dup := registry[r.Extractor]; dup {
		panic("extractor: " + r.Extractor + " registered twice")
	}
	registry[r.Extractor] = e
}

func All() []Extractor {
	mu.RLock()
	defer mu.RUnlock()
	names := make([]string, 0, len(registry))
	for name := range registry {
		names = append(names, name)
	}
	sort.Strings(names)
	all := make([]Extractor, 0, len(names))
	for _, name := range names {
		all = append(all, registry[name])
	}
	return all
}

func Lookup(name string) (Extractor, bool) {
	mu.RLock()
	defer mu.RUnlock()
	e, ok := registry[name]
	return e, ok
}

func Rules() []Rule {
	all := All()
	rules := make([]Rule, 0, len(all))
	for _, e := range all {
		rules = append(rules, e.Rule().WithDefaults())
	}
	return rules
}

func (r Rule) WithDefaults() Rule {
	if r.DwellMS == 0 {
		r.DwellMS = DefaultDwellMS
	}
	if r.MaxBytes == 0 {
		r.MaxBytes = DefaultMaxBytes
	}
	if r.Recapture == "" {
		r.Recapture = RecaptureNever
	}
	if r.QueryKeys == nil {
		r.QueryKeys = []string{}
	}
	return r
}

func (r Rule) Matches(u *url.URL) bool {
	host := strings.ToLower(u.Hostname())
	hostOK := false
	for _, h := range r.Hosts {
		if h == host || (strings.HasPrefix(h, "*.") && strings.HasSuffix(host, h[1:])) {
			hostOK = true
			break
		}
	}
	if !hostOK {
		return false
	}
	if r.PathRegex == "" {
		return true
	}
	re, err := regexp.Compile(r.PathRegex)
	return err == nil && re.MatchString(u.Path)
}

func MatchRule(rules []Rule, u *url.URL) (Rule, bool) {
	for _, r := range rules {
		if r.Matches(u) {
			return r, true
		}
	}
	return Rule{}, false
}

// CanonicalJSON is the byte form record_hash is taken over: keys sorted at
// every level, numbers verbatim, so the same data always hashes the same
// regardless of struct field order or map iteration.
func CanonicalJSON(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var generic any
	if err := dec.Decode(&generic); err != nil {
		return nil, err
	}
	return json.Marshal(generic)
}

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
	"slices"
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

// ErrStale means the page state the extractor reads belongs to another URL:
// a single-page app navigated in place and left the previous page's embedded
// data in the DOM. Recorded and never retried, like ErrNoMatch.
var ErrStale = errors.New("extractor: page state belongs to another url")

const (
	DefaultDwellMS      = 5000
	DefaultMaxBytes     = 10 << 20
	RecaptureNever      = "never"
	RecaptureAfterQuiet = "after_quiet"
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

// Rules puts the wildcard rules last so a client that takes the first
// match in the published order still prefers a site extractor over the
// article fallback.
func Rules() []Rule {
	all := All()
	rules := make([]Rule, 0, len(all))
	wildcards := make([]Rule, 0, len(all))
	for _, e := range all {
		r := e.Rule().WithDefaults()
		if r.isWildcard() {
			wildcards = append(wildcards, r)
		} else {
			rules = append(rules, r)
		}
	}
	return append(rules, wildcards...)
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
	return r.matchesHost(u) && r.matchesPath(u)
}

func (r Rule) matchesHost(u *url.URL) bool {
	host := strings.ToLower(u.Hostname())
	for _, h := range r.Hosts {
		if h == "*" || h == host || (strings.HasPrefix(h, "*.") && strings.HasSuffix(host, h[1:])) {
			return true
		}
	}
	return false
}

func (r Rule) matchesPath(u *url.URL) bool {
	if r.PathRegex == "" {
		return true
	}
	re, err := regexp.Compile(r.PathRegex)
	return err == nil && re.MatchString(u.Path)
}

func (r Rule) isWildcard() bool {
	return slices.Contains(r.Hosts, "*")
}

// MatchRule tries every host-specific rule before any wildcard one, whatever
// the slice order. A host any site rule names is that rule's alone: its other
// pages are app shell, not articles, so they never fall through to the
// wildcard.
func MatchRule(rules []Rule, u *url.URL) (Rule, bool) {
	claimed := false
	for _, r := range rules {
		if r.isWildcard() || !r.matchesHost(u) {
			continue
		}
		claimed = true
		if r.matchesPath(u) {
			return r, true
		}
	}
	if claimed {
		return Rule{}, false
	}
	for _, r := range rules {
		if r.isWildcard() && r.Matches(u) {
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

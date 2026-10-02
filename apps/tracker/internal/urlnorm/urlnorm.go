// Package urlnorm turns the URLs the extension reports into one stable form,
// so the same page seen through different tracking parameters, ports or
// fragments lands on one urls row.
package urlnorm

import (
	"errors"
	"net/url"
	"regexp"
	"strings"

	"lukechampine.com/blake3"
)

var ErrNotHTTP = errors.New("urlnorm: not an absolute http(s) url")

var strippedKeys = map[string]bool{
	"fbclid": true, "gclid": true, "ref": true, "si": true, "mc_cid": true, "mc_eid": true,
}

var percent = regexp.MustCompile(`%(?:[0-9A-Fa-f]{2})?`)

func Normalize(raw string) (normalized, host string, err error) {
	raw, _, _ = strings.Cut(strings.TrimSpace(raw), "#")
	u, err := url.Parse(raw)
	if err != nil {
		// Chrome keeps a '%' that starts no escape, and percent-decoding reads
		// it as a literal '%'; url.Parse rejects the whole URL instead.
		u, err = url.Parse(escapeStrayPercents(raw))
	}
	if err != nil {
		return "", "", err
	}
	u.Scheme = strings.ToLower(u.Scheme)
	host = strings.ToLower(u.Hostname())
	if (u.Scheme != "http" && u.Scheme != "https") || host == "" {
		return "", "", ErrNotHTTP
	}
	port := u.Port()
	if (u.Scheme == "http" && port == "80") || (u.Scheme == "https" && port == "443") {
		port = ""
	}
	u.Host = host
	if strings.Contains(host, ":") {
		u.Host = "[" + host + "]"
	}
	if port != "" {
		u.Host += ":" + port
	}
	u.User = nil
	if u.Path == "" {
		u.Path = "/"
	}
	// A query ParseQuery rejects, one with a ';' or a stray '%', is kept as
	// sent: its parsed form has already lost the segments that failed, and
	// two different pages would share one row.
	if q, err := url.ParseQuery(u.RawQuery); err == nil {
		for k := range q {
			if strippedKeys[k] || strings.HasPrefix(k, "utm_") {
				delete(q, k)
			}
		}
		u.RawQuery = q.Encode()
	}
	u.ForceQuery = false
	return u.String(), host, nil
}

func escapeStrayPercents(s string) string {
	return percent.ReplaceAllStringFunc(s, func(m string) string {
		if m == "%" {
			return "%25"
		}
		return m
	})
}

func Hash(normalized string) []byte {
	sum := blake3.Sum256([]byte(normalized))
	return sum[:]
}

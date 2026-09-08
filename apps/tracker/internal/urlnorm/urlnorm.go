// Package urlnorm turns the URLs the extension reports into one stable form,
// so the same page seen through different tracking parameters, ports or
// fragments lands on one urls row.
package urlnorm

import (
	"errors"
	"net/url"
	"strings"

	"lukechampine.com/blake3"
)

var ErrNotHTTP = errors.New("urlnorm: not an absolute http(s) url")

var strippedKeys = map[string]bool{
	"fbclid": true, "gclid": true, "ref": true, "si": true, "mc_cid": true, "mc_eid": true,
}

func Normalize(raw string) (normalized, host string, err error) {
	u, err := url.Parse(strings.TrimSpace(raw))
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
	if port != "" {
		u.Host = host + ":" + port
	}
	u.User = nil
	u.Fragment = ""
	u.RawFragment = ""
	if u.Path == "" {
		u.Path = "/"
	}
	q := u.Query()
	for k := range q {
		if strippedKeys[k] || strings.HasPrefix(k, "utm_") {
			delete(q, k)
		}
	}
	u.RawQuery = q.Encode()
	u.ForceQuery = false
	return u.String(), host, nil
}

func Hash(normalized string) []byte {
	sum := blake3.Sum256([]byte(normalized))
	return sum[:]
}

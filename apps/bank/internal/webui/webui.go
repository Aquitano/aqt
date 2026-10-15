// Package webui serves the archive browser: an embedded single-page app
// (app/ — Vite + React, built with `bun run build`, dist/ committed so `go
// build` needs no JS toolchain) plus a reverse proxy that forwards /v1 to a
// remote `bank serve` with the bearer token attached server-side. The token
// never reaches the browser, and the listener is meant for 127.0.0.1 only —
// this is a viewer for one person's desk, not a deployment target.
package webui

//go:generate bun --cwd app run build

import (
	"embed"
	"io/fs"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

//go:embed all:app/dist
var content embed.FS

func Handler(apiBase *url.URL, token string, allowedHosts ...string) http.Handler {
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(apiBase)
			r.Out.Host = apiBase.Host
			r.Out.Header.Set("Authorization", "Bearer "+token)
		},
	}

	dist, err := fs.Sub(content, "app/dist")
	if err != nil {
		panic(err) // embed guarantees the directory exists
	}

	api := http.NewCrossOriginProtection().Handler(proxy)
	mux := http.NewServeMux()
	mux.Handle("/v1/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowedHost(r.Host, allowedHosts) {
			http.Error(w, "unrecognized local UI host", http.StatusForbidden)
			return
		}
		api.ServeHTTP(w, r)
	}))
	mux.Handle("/", http.FileServerFS(dist))
	return mux
}

func allowedHost(authority string, configured []string) bool {
	host, _, err := net.SplitHostPort(authority)
	if err != nil {
		host = authority
	}
	host = strings.TrimSuffix(strings.ToLower(strings.Trim(host, "[]")), ".")
	if host == "localhost" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return true
	}
	for _, value := range configured {
		if host == strings.TrimSuffix(strings.ToLower(strings.Trim(value, "[]")), ".") {
			return true
		}
	}
	return false
}

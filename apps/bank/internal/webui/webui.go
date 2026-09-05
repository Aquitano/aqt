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
	"net/http"
	"net/http/httputil"
	"net/url"
)

//go:embed all:app/dist
var content embed.FS

func Handler(apiBase *url.URL, token string) http.Handler {
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

	mux := http.NewServeMux()
	mux.Handle("/v1/", proxy)
	mux.Handle("/", http.FileServerFS(dist))
	return mux
}

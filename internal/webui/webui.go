// Package webui serves the archive browser: a single embedded page plus a
// reverse proxy that forwards /v1 to a remote `bank serve` with the bearer
// token attached server-side. The token never reaches the browser, and the
// listener is meant for 127.0.0.1 only — this is a viewer for one person's
// desk, not a deployment target.
package webui

import (
	"embed"
	"net/http"
	"net/http/httputil"
	"net/url"
)

//go:embed index.html
var content embed.FS

func Handler(apiBase *url.URL, token string) http.Handler {
	proxy := httputil.NewSingleHostReverseProxy(apiBase)
	director := proxy.Director
	proxy.Director = func(r *http.Request) {
		director(r)
		r.Host = apiBase.Host
		r.Header.Set("Authorization", "Bearer "+token)
	}

	mux := http.NewServeMux()
	mux.Handle("/v1/", proxy)
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		page, err := content.ReadFile("index.html")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(page)
	})
	return mux
}

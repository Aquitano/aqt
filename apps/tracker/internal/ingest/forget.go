package ingest

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"golang.org/x/net/publicsuffix"

	"github.com/aquitano/aqt/apps/tracker/internal/store"
)

const maxForgetBody = 8 << 10

func (s *Server) handleForget(w http.ResponseWriter, r *http.Request) {
	var body store.ForgetTarget
	if err := json.NewDecoder(io.LimitReader(r.Body, maxForgetBody)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return
	}
	target, ok := forgetTarget(body)
	if !ok {
		writeErr(w, http.StatusBadRequest, `body needs exactly one of "url", an http(s) url, and "host", a host that is not a public suffix`)
		return
	}
	forgotten, err := s.store.Forget(r.Context(), target)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, forgotten)
}

// forgetTarget normalises a URL the way ingest stores one and a host the way
// the extension's private-host list reads one. A host covers its subdomains,
// so a public suffix such as "com" or "co.uk" is refused: one typo would
// forget every site under it.
func forgetTarget(in store.ForgetTarget) (store.ForgetTarget, bool) {
	if (in.URL == "") == (in.Host == "") {
		return store.ForgetTarget{}, false
	}
	if in.URL != "" {
		key, ok := urlKey(in.URL)
		return store.ForgetTarget{URL: key.Normalized}, ok
	}
	host := strings.TrimPrefix(strings.TrimSpace(in.Host), "*.")
	if !strings.Contains(host, "://") {
		host = "https://" + host
	}
	key, ok := urlKey(host)
	if suffix, icann := publicsuffix.PublicSuffix(key.Host); !ok || (icann && suffix == key.Host) {
		return store.ForgetTarget{}, false
	}
	return store.ForgetTarget{Host: key.Host}, true
}

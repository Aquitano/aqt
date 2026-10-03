package webui

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestProxyRejectsCrossOriginWrites(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer private-token" {
			t.Error("proxy omitted token")
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer backend.Close()
	u, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	handler := Handler(u, "private-token")
	for _, test := range []struct {
		method, origin, site string
		status               int
	}{
		{"GET", "https://elsewhere.example", "cross-site", 204},
		{"POST", "http://localhost:8080", "same-origin", 204},
		{"POST", "https://elsewhere.example", "cross-site", 403},
		{"POST", "", "cross-site", 403},
		{"PUT", "null", "", 403},
	} {
		r := httptest.NewRequest(test.method, "http://localhost:8080/v1/library/files", nil)
		r.Header.Set("Origin", test.origin)
		r.Header.Set("Sec-Fetch-Site", test.site)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != test.status {
			t.Errorf("%s origin=%q site=%q: got %d", test.method, test.origin, test.site, w.Code)
		}
	}
}

func TestProxyRejectsReboundHosts(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer backend.Close()
	target, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	handler := Handler(target, "private-token", "desk.internal")
	for _, test := range []struct {
		host   string
		status int
	}{{"localhost:8481", 204}, {"127.0.0.1:8481", 204}, {"[::1]:8481", 204}, {"desk.internal:8481", 204}, {"attacker.example:8481", 403}} {
		for _, method := range []string{"GET", "POST"} {
			r := httptest.NewRequest(method, "http://"+test.host+"/v1/library/items", nil)
			r.Header.Set("Origin", "http://"+test.host)
			r.Header.Set("Sec-Fetch-Site", "same-origin")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, r)
			if response.Code != test.status {
				t.Errorf("%s %s: got %d want %d", method, test.host, response.Code, test.status)
			}
		}
	}
}

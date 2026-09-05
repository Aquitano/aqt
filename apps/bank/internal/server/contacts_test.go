package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/store"
)

func TestContactRoutes(t *testing.T) {
	s, token := testServer(t)
	s.read.(*fakeReader).contacts = []store.Contact{{
		ID: 1, Name: "bjoern",
		Aliases: []store.ContactAlias{{Value: "bjoern@example.com", Normalized: "bjoern@example.com"}},
	}}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()

	t.Run("list", func(t *testing.T) {
		status, body := authedGet(t, srv, token, "/v1/contacts")
		if status != http.StatusOK {
			t.Fatalf("status %d (%s)", status, body)
		}
		var got []store.Contact
		if err := json.Unmarshal([]byte(body), &got); err != nil {
			t.Fatal(err)
		}
		if len(got) != 1 || got[0].Name != "bjoern" {
			t.Fatalf("payload = %s", body)
		}
	})

	t.Run("show", func(t *testing.T) {
		status, body := authedGet(t, srv, token, "/v1/contacts/bjoern")
		if status != http.StatusOK {
			t.Fatalf("status %d (%s)", status, body)
		}
		if !strings.Contains(body, "bjoern@example.com") || !strings.Contains(body, `"sources"`) {
			t.Errorf("payload = %s", body)
		}
	})

	t.Run("show unknown is 404", func(t *testing.T) {
		if status, body := authedGet(t, srv, token, "/v1/contacts/nobody"); status != http.StatusNotFound {
			t.Fatalf("status %d, want 404 (%s)", status, body)
		}
	})

	t.Run("messages for an unknown contact is 404", func(t *testing.T) {
		if status, body := authedGet(t, srv, token, "/v1/contacts/nobody/messages"); status != http.StatusNotFound {
			t.Fatalf("status %d, want 404 (%s)", status, body)
		}
	})

	t.Run("suggest", func(t *testing.T) {
		status, body := authedGet(t, srv, token, "/v1/contacts/suggest")
		if status != http.StatusOK {
			t.Fatalf("status %d (%s)", status, body)
		}
		if strings.TrimSpace(body) != "[]" {
			t.Errorf("empty suggestions should be [], got %q", strings.TrimSpace(body))
		}
	})

	t.Run("suggest is not read as a contact name", func(t *testing.T) {
		// The literal route has to win over /v1/contacts/{name}, or the
		// suggest endpoint becomes a lookup for a contact called "suggest".
		_, body := authedGet(t, srv, token, "/v1/contacts/suggest")
		if strings.Contains(body, "no contact") {
			t.Errorf("suggest fell through to the name route: %s", body)
		}
	})
}

func TestSearchByUnknownPersonIsABadRequest(t *testing.T) {
	s, token := testServer(t)
	s.read.(*fakeReader).searchErr = &store.ErrNoContact{Name: "nobody"}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	status, body := authedGet(t, srv, token, "/v1/search?q=hi&person=nobody")
	if status != http.StatusBadRequest {
		t.Fatalf("status %d, want 400 (%s)", status, body)
	}
	if !strings.Contains(body, "nobody") {
		t.Errorf("the error should name the contact: %s", body)
	}
}

func TestSearchPassesPersonThrough(t *testing.T) {
	s, token := testServer(t)
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	if status, body := authedGet(t, srv, token, "/v1/search?q=hi&person=bjoern"); status != http.StatusOK {
		t.Fatalf("status %d (%s)", status, body)
	}
	if got := s.read.(*fakeReader).opts.Person; got != "bjoern" {
		t.Errorf("person = %q, want it forwarded to the store", got)
	}
}

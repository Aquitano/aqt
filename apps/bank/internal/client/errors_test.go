package client

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	atticstore "github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// A failure over HTTP is the error a local call returns: the same sentinel
// for errors.Is, and the same typed error, candidates included, for As.
func TestTaggedFailuresAreTheStoresErrors(t *testing.T) {
	bodies := map[string]struct {
		status int
		body   string
	}{
		"/v1/refs/content:1111111111111111": {http.StatusConflict, `{"_tag":"AmbiguousRef","message":"ref content:1111111111111111 is ambiguous","ref":"content:1111111111111111",` +
			`"candidates":[{"ref":"content:1111111111111111a","size":6},{"ref":"content:1111111111111111b","size":7,"volume":"Archive","path":"/b.txt"}]}`},
		"/v1/threads/old": {http.StatusConflict, `{"_tag":"MailThreadConflict","message":"split","code":"mail_thread_conflict","source":"gmail",` +
			`"conflict_key":"k","choices":["a","b"],"unanchored_path":"/v1/mail-conflicts/k?source=gmail"}`},
		"/v1/messages/msg:0123456789abcdef": {http.StatusNotFound, `{"_tag":"NotFound","message":"message msg:0123456789abcdef: not found"}`},
		"/v1/contacts/nobody":               {http.StatusUnprocessableEntity, `{"_tag":"InvalidRequest","message":"no contact"}`},
		"/v1/stats":                         {http.StatusBadGateway, `upstream down`},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		answer := bodies[r.URL.Path]
		w.WriteHeader(answer.status)
		_, _ = io.WriteString(w, answer.body)
	}))
	defer server.Close()
	c, ctx := New(server.URL, "secret"), context.Background()

	cited, err := ref.Parse("content:1111111111111111")
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.Resolve(ctx, cited)
	ambiguous, ok := errors.AsType[*atticstore.AmbiguousRefError](err)
	if !ok || ambiguous.Ref != "content:1111111111111111" || len(ambiguous.Candidates) != 2 || ambiguous.Candidates[1].Path != "/b.txt" {
		t.Fatalf("an ambiguous ref answered %#v", err)
	}
	local := &atticstore.AmbiguousRefError{Ref: ambiguous.Ref, Candidates: ambiguous.Candidates}
	if err.Error() != local.Error() {
		t.Fatalf("remote message %q, local %q", err, local)
	}

	_, err = c.GetThreadPage(ctx, "gmail", "old", store.ThreadOpts{})
	if conflict, ok := errors.AsType[*store.MailThreadConflictError](err); !ok || len(conflict.Choices) != 2 {
		t.Fatalf("a mail thread conflict answered %#v", err)
	}

	cite, err := ref.ParseMessage("msg:0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = c.GetMessageDetailByRef(ctx, cite); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a missing message outside the library answered %v", err)
	}
	if _, err = c.GetContactDetail(ctx, "nobody"); !errors.Is(err, fail.ErrInvalid) || err.Error() != "no contact" {
		t.Fatalf("an invalid request answered %v", err)
	}
	if _, err = c.Stats(ctx); err == nil || errors.Is(err, store.ErrNotFound) || err.Error() != "502 Bad Gateway: upstream down" {
		t.Fatalf("an untagged failure answered %v", err)
	}
}

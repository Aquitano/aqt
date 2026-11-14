package main

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/page"
)

func TestCLIParsesDocumentedForms(t *testing.T) {
	for _, tt := range []struct {
		args  []string
		check func(cli) bool
	}{
		{[]string{"search", "words", "--json", "--source", "gmail"}, func(c cli) bool {
			return reflect.DeepEqual(c.Search.Query, []string{"words"}) && c.Search.JSON && c.Search.Source == "gmail" && c.Search.Limit == page.DefaultLimit
		}},
		{[]string{"search", "--json", "--", "-foo", "--source"}, func(c cli) bool {
			return reflect.DeepEqual(c.Search.Query, []string{"-foo", "--source"}) && c.Search.JSON && c.Search.Source == ""
		}},
		{[]string{"search", "--source", "-json", "words"}, func(c cli) bool {
			return reflect.DeepEqual(c.Search.Query, []string{"words"}) && !c.Search.JSON && c.Search.Source == "-json"
		}},
		{[]string{"extract", "--status", "failed", "--status", "empty"}, func(c cli) bool {
			return reflect.DeepEqual(c.Extract.Status, []string{"failed", "empty"}) && c.Extract.Interval == 30*time.Minute && c.Extract.Lang == "eng"
		}},
		{[]string{"fetch", strings.Repeat("ab", 32), "-o", "out.jpg"}, func(c cli) bool {
			return c.Fetch.BLAKE3.String() == strings.Repeat("ab", 32) && c.Fetch.Output == "out.jpg"
		}},
		{[]string{"import", "json", "--source", "notes", "-"}, func(c cli) bool {
			return reflect.DeepEqual(c.Import.JSON.Paths, []string{"-"}) && c.Import.JSON.Source == "notes"
		}},
		{[]string{"contact", "alias", "remove", "alice", "whatsapp:Alice"}, func(c cli) bool {
			return c.Contact.Alias.Rm.Name == "alice" && reflect.DeepEqual(c.Contact.Alias.Rm.Aliases, []string{"whatsapp:Alice"})
		}},
		{[]string{"retire", "--source", "youtube", "--external-prefix", "watch:", "--external-prefix", "playlist:"}, func(c cli) bool {
			return c.Retire.Source == "youtube" && reflect.DeepEqual(c.Retire.ExternalPrefix, []string{"watch:", "playlist:"}) && !c.Retire.Apply
		}},
		{[]string{"mail", "conflict", "key", "--source", "gmail", "--json"}, func(c cli) bool {
			return c.Mail.Conflict.Key == "key" && c.Mail.Source == "gmail" && c.Mail.Conflict.Limit == page.DefaultLimit
		}},
	} {
		t.Run(strings.Join(tt.args, " "), func(t *testing.T) {
			var root cli
			if _, err := newParser(&root).Parse(tt.args); err != nil {
				t.Fatal(err)
			}
			if !tt.check(root) {
				t.Fatalf("parsed %+v", root)
			}
		})
	}
}

func TestSearchDashQueryReachesServer(t *testing.T) {
	var query string
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query = r.URL.Query().Get("q")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{}`)
	}))
	defer remote.Close()
	t.Setenv("BANK_URL", remote.URL)
	t.Setenv("BANK_TOKEN", "test")
	if err := execute(context.Background(), []string{"search", "--json", "--", "-foo"}); err != nil {
		t.Fatal(err)
	}
	if query != "-foo" {
		t.Fatalf("query=%q, want -foo", query)
	}
}

func TestHumanBytesHandlesLargeArchives(t *testing.T) {
	for n, want := range map[int64]string{0: "0B", 1024: "1.0K", 1 << 40: "1.0T", 1 << 50: "1.0P", 1 << 60: "1.0E", math.MaxInt64: "8.0E"} {
		if got := humanBytes(n); got != want {
			t.Errorf("humanBytes(%d)=%s, want %s", n, got, want)
		}
	}
}

func TestHealthcheckReportsHTTPFailure(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusServiceUnavailable} {
		remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(status) }))
		err := execute(context.Background(), []string{"healthcheck", remote.URL})
		remote.Close()
		if (err == nil) != (status == http.StatusOK) {
			t.Errorf("status %d: %v", status, err)
		}
	}
}

func TestLibraryGetRoutesByIDKind(t *testing.T) {
	var path string
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{}`)
	}))
	defer remote.Close()
	t.Setenv("BANK_URL", remote.URL)
	t.Setenv("BANK_TOKEN", "test")
	const id = "0123456789abcdef0123456789abcdef"
	for cited, want := range map[string]string{
		"item:" + id:       "/v1/library/items/item:" + id,
		"activity:" + id:   "/v1/library/activity/activity:" + id,
		"collection:" + id: "/v1/library/collections/collection:" + id,
		"file:" + id:       "/v1/library/files/file:" + id,
		"page:" + id:       "/v1/library/pages/page:" + id,
	} {
		if err := execute(context.Background(), []string{"library", "get", cited}); err != nil {
			t.Fatal(err)
		}
		if path != want {
			t.Errorf("get %s requested %s, want %s", cited, path, want)
		}
	}
}

func TestShowPrintsRetiredRefs(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusGone)
		fmt.Fprint(w, `{"_tag":"MessageRetired","message":"message msg:0123456789abcdef was retired","retired":{"ref":"msg:0123456789abcdef","source":"youtube","external_id":"watch:1","replacement":"activity:0123456789abcdef0123456789abcdef"}}`)
	}))
	defer remote.Close()
	t.Setenv("BANK_URL", remote.URL)
	t.Setenv("BANK_TOKEN", "test")
	for _, args := range [][]string{{"show", "msg:0123456789abcdef"}, {"show", "msg:0123456789abcdef", "--json"}} {
		if err := execute(context.Background(), args); err != nil {
			t.Errorf("%v: %v", args, err)
		}
	}
}

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
)

func TestCLIParsesDocumentedForms(t *testing.T) {
	for _, tt := range []struct {
		args  []string
		check func(cli) bool
	}{
		{[]string{"search", "words", "--json", "--source", "gmail"}, func(c cli) bool {
			return reflect.DeepEqual(c.Search.Query, []string{"words"}) && c.Search.JSON && c.Search.Source == "gmail" && c.Search.Limit == 20
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
		{[]string{"fetch", "abc", "-o", "out.jpg"}, func(c cli) bool { return c.Fetch.SHA256 == "abc" && c.Fetch.Output == "out.jpg" }},
		{[]string{"import", "json", "--source", "notes", "-"}, func(c cli) bool {
			return reflect.DeepEqual(c.Import.JSON.Paths, []string{"-"}) && c.Import.JSON.Source == "notes"
		}},
		{[]string{"contact", "alias", "remove", "alice", "whatsapp:Alice"}, func(c cli) bool {
			return c.Contact.Alias.Rm.Name == "alice" && reflect.DeepEqual(c.Contact.Alias.Rm.Aliases, []string{"whatsapp:Alice"})
		}},
		{[]string{"mail", "conflict", "key", "--source", "gmail", "--json"}, func(c cli) bool {
			return c.Mail.Conflict.Key == "key" && c.Mail.Source == "gmail" && c.Mail.Conflict.Limit == 100
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

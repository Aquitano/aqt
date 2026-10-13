package main

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

func TestCommandFlagsPreserveCLIForms(t *testing.T) {
	for _, tt := range []struct {
		args, positional []string
		json             bool
		source           string
		statuses         []string
	}{
		{[]string{"words", "--json", "--source", "gmail"}, []string{"words"}, true, "gmail", nil},
		{[]string{"words", "-json", "-source=gmail"}, []string{"words"}, true, "gmail", nil},
		{[]string{"--json", "--", "-foo", "--source"}, []string{"-foo", "--source"}, true, "", nil},
		{[]string{"--source", "-json", "words"}, []string{"words"}, false, "-json", nil},
		{[]string{"--status", "failed", "--status", "empty", "-"}, []string{"-"}, false, "", []string{"failed", "empty"}},
	} {
		t.Run(fmt.Sprint(tt.args), func(t *testing.T) {
			opts := struct {
				CommandArguments
				JSON     bool `name:"json"`
				Source   string
				Limit    int           `default:"20"`
				Status   []string      `sep:"none"`
				Interval time.Duration `default:"30m"`
			}{}
			if err := parseCommand("test", &opts, tt.args); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(opts.Args, tt.positional) || opts.JSON != tt.json || opts.Source != tt.source || !reflect.DeepEqual(opts.Status, tt.statuses) || opts.Limit != 20 || opts.Interval != 30*time.Minute {
				t.Fatalf("parsed %+v", opts)
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
	if err := cmdSearch(context.Background(), []string{"--json", "--", "-foo"}); err != nil {
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
		err := cmdHealthcheck(context.Background(), []string{remote.URL})
		remote.Close()
		if (err == nil) != (status == http.StatusOK) {
			t.Errorf("status %d: %v", status, err)
		}
	}
}

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
			return reflect.DeepEqual(c.Extract.Status, []string{"failed", "empty"}) && c.Extract.Lang == "eng"
		}},
		{[]string{"worker", "--queue", "ocr", "--lang", "deu+eng"}, func(c cli) bool {
			return c.Worker.Queue == "ocr" && c.Worker.Workers == 1 && c.Worker.Lang == "deu+eng"
		}},
		{[]string{"fetch", strings.Repeat("ab", 32), "-o", "out.jpg"}, func(c cli) bool {
			return c.Fetch.BLAKE3.String() == strings.Repeat("ab", 32) && c.Fetch.Output == "out.jpg"
		}},
		{[]string{"contact", "alias", "remove", "alice", "whatsapp:Alice"}, func(c cli) bool {
			return c.Contact.Alias.Rm.Name == "alice" && reflect.DeepEqual(c.Contact.Alias.Rm.Aliases, []string{"whatsapp:Alice"})
		}},
		{[]string{"retire", "--source", "youtube", "--external-prefix", "watch:", "--external-prefix", "playlist:"}, func(c cli) bool {
			return c.Retire.Source == "youtube" && reflect.DeepEqual(c.Retire.ExternalPrefix, []string{"watch:", "playlist:"}) && !c.Retire.Apply
		}},
		{[]string{"disk", "search", "minecraft", "server", "--ext", "rar", "--json"}, func(c cli) bool {
			return reflect.DeepEqual(c.Disk.Search.Words, []string{"minecraft", "server"}) && c.Disk.Search.Ext == "rar" && c.Disk.Search.JSON && c.Disk.Search.Limit == page.DefaultLimit
		}},
		{[]string{"disk", "scan", `E:\Files`, "--volume", "known", "--new-volume=false"}, func(c cli) bool {
			return c.Disk.Scan.Folder == `E:\Files` && c.Disk.Scan.Volume == "known" && !c.Disk.Scan.NewVolume && c.Disk.Scan.LogLevel == "info"
		}},
		{[]string{"disk", "enrich", "123", "content:0123456789abcdef", "--task", "ocr", "--force"}, func(c cli) bool {
			return reflect.DeepEqual(c.Disk.Enrich.Targets, []string{"123", "content:0123456789abcdef"}) && c.Disk.Enrich.Task == "ocr" && c.Disk.Enrich.Force && c.Disk.Enrich.Limit == 20
		}},
		{[]string{"disk", "get", "content:0123456789abcdef", "--to", "recovered.pdf", "--json"}, func(c cli) bool {
			return c.Disk.Get.To == "recovered.pdf" && c.Disk.Get.JSON
		}},
		{[]string{"disk", "dedupe", "plan", "--keep", `E:\Files`, "--keep", `F:\Photos`}, func(c cli) bool {
			return reflect.DeepEqual(c.Disk.Dedupe.Plan.Keep, []string{`E:\Files`, `F:\Photos`}) && c.Disk.Dedupe.Plan.MinSize == "1M"
		}},
		{[]string{"show", "content:0123456789abcdef", "--text"}, func(c cli) bool {
			return c.Show.Ref.String() == "content:0123456789abcdef" && c.Show.Text
		}},
	} {
		t.Run(strings.Join(tt.args, " "), func(t *testing.T) {
			root := newCLI()
			if _, err := newParser(root).Parse(tt.args); err != nil {
				t.Fatal(err)
			}
			if !tt.check(*root) {
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

func TestCLIRejectsInvalidSelections(t *testing.T) {
	for _, args := range [][]string{
		{"disk", "search", "words", "--kind", "folder"},
		{"disk", "enrich", "123", "--task", "caption"},
		{"disk", "enrich", "123"},
		{"disk", "scan", `E:\`, "--volume", "known", "--new-volume"},
		{"disk", "scan", `E:\`, "--no-hash", "--rebuild-content"},
		{"disk", "get", "123", "456", "--to", "file"},
		{"show", "msg:0123456789abcdef", "--text"},
		{"show", "content:0123456789abcdef", "--provenance"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			if _, err := newParser(newCLI()).Parse(args); err == nil {
				t.Fatal("invalid selection accepted")
			}
		})
	}
}

func TestHumanSizeHandlesLargeArchives(t *testing.T) {
	for n, want := range map[int64]string{0: "0 B", 1024: "1.0 KB", 1 << 40: "1.0 TB", 1 << 50: "1.0 PB", 1 << 60: "1.0 EB", math.MaxInt64: "8.0 EB"} {
		if got := humanSize(n); got != want {
			t.Errorf("humanSize(%d)=%s, want %s", n, got, want)
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

func TestShowRoutesLibraryRefsByKind(t *testing.T) {
	var path string
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/v1/refs/") {
			path = r.URL.Path
		}
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
		if err := execute(context.Background(), []string{"show", cited, "--json"}); err != nil {
			t.Fatal(err)
		}
		if path != want {
			t.Errorf("show %s requested %s, want %s", cited, path, want)
		}
	}
}

func TestShowPrintsRetiredRefs(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasPrefix(r.URL.Path, "/v1/refs/") {
			fmt.Fprint(w, `{"ref":"msg:0123456789abcdef","kind":"retired_message","href":"/v1/messages/msg:0123456789abcdef","links":[]}`)
			return
		}
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

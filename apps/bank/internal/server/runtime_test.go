package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestHealthChecksDatabase(t *testing.T) {
	pool := storetest.Pool(t, storetest.Migrated(t))
	server := New(store.New(pool), nil, t.TempDir(), nil)
	for _, status := range []int{http.StatusOK, http.StatusServiceUnavailable} {
		if status == http.StatusServiceUnavailable {
			pool.Close()
		}
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, httptest.NewRequest("GET", "/healthz", nil))
		if response.Code != status {
			t.Fatalf("status %d, want %d", response.Code, status)
		}
		if status == http.StatusOK && !strings.Contains(response.Body.String(), `"schema_version":1`) {
			t.Fatalf("health does not report the schema version: %s", response.Body)
		}
	}
}

func TestInternalErrorsDoNotExposeDetails(t *testing.T) {
	body, err := json.Marshal(failure(errors.New("connection failed: postgres://private:password@db")))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "password") || !strings.Contains(string(body), "Internal Server Error") {
		t.Fatal(string(body))
	}
}

func TestShutdownDrainsActiveRequest(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	started, release := make(chan struct{}), make(chan struct{})
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		_, _ = io.WriteString(w, "finished")
	}), ReadHeaderTimeout: time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- run(ctx, srv, func() error { return srv.Serve(listener) }) }()
	result := make(chan error, 1)
	go func() {
		response, err := http.Get("http://" + listener.Addr().String())
		if err != nil {
			result <- err
			return
		}
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		if err == nil && string(raw) != "finished" {
			err = errors.New("response interrupted")
		}
		result <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("request did not start")
	}
	cancel()
	select {
	case err := <-done:
		t.Fatalf("returned before request drained: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown did not finish")
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}

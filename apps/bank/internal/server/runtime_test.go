package server

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestHealthChecksDatabase(t *testing.T) {
	db := storetest.New(t)
	server := New(db, nil, t.TempDir(), t.TempDir())
	for _, status := range []int{http.StatusOK, http.StatusServiceUnavailable} {
		if status == http.StatusServiceUnavailable {
			db.Close()
		}
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, httptest.NewRequest("GET", "/healthz", nil))
		if response.Code != status {
			t.Fatalf("status %d, want %d", response.Code, status)
		}
	}
}

func TestInternalErrorsDoNotExposeDetails(t *testing.T) {
	response := httptest.NewRecorder()
	writeErr(response, 500, "connection failed: postgres://private:password@db")
	if strings.Contains(response.Body.String(), "password") || !strings.Contains(response.Body.String(), "Internal Server Error") {
		t.Fatal(response.Body.String())
	}
}

func TestJSONUploadLimit(t *testing.T) {
	s := &Server{}
	request := httptest.NewRequest("POST", "/v1/import/json", strings.NewReader("unused"))
	request.SetPathValue("kind", "json")
	request.ContentLength = maxJSONUpload + 1
	response := httptest.NewRecorder()
	s.handleImport(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status %d", response.Code)
	}
	// Unknown content lengths, as used by chunked requests, hit the same cap.
	request = httptest.NewRequest("POST", "/v1/import/json", io.LimitReader(zeroReader{}, maxJSONUpload+1))
	request.SetPathValue("kind", "json")
	response = httptest.NewRecorder()
	s.handleImport(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("chunked status %d", response.Code)
	}
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) { clear(p); return len(p), nil }

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

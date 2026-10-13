package server

import (
	"bufio"
	"context"
	"errors"
	"fmt"
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

func newJSONTestServer(t *testing.T, timeout time.Duration) (*httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	token, err := NewToken(dir, "test")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{dataDir: dir, jsonReadTimeout: timeout}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	srv.Client().Timeout = 5 * time.Second
	return srv, token
}

func postOversizedJSON(t *testing.T, srv *httptest.Server, token string, contentLength int64) {
	t.Helper()
	request, err := http.NewRequest("POST", srv.URL+"/v1/import/json", io.LimitReader(zeroReader{}, maxJSONUpload+1))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.ContentLength = contentLength
	response, err := srv.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status %d, want 413", response.StatusCode)
	}
}

func TestJSONUploadLimit(t *testing.T) {
	srv, token := newJSONTestServer(t, 0)
	postOversizedJSON(t, srv, token, maxJSONUpload+1)
	// Chunked uploads with no advertised length must hit the same cap.
	postOversizedJSON(t, srv, token, -1)
}

func TestStalledJSONUploadsReleaseImportSlots(t *testing.T) {
	srv, token := newJSONTestServer(t, 2*time.Second)
	var stalled []net.Conn
	for range cap(jsonImports) {
		conn, err := net.DialTimeout("tcp", strings.TrimPrefix(srv.URL, "http://"), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
			t.Fatal(err)
		}
		_, err = fmt.Fprintf(conn, "POST /v1/import/json HTTP/1.1\r\nHost: bank\r\nAuthorization: Bearer %s\r\nContent-Length: 100\r\n\r\n{", token)
		if err != nil {
			t.Fatal(err)
		}
		stalled = append(stalled, conn)
	}
	deadline := time.Now().Add(time.Second)
	for len(jsonImports) != cap(jsonImports) {
		if time.Now().After(deadline) {
			t.Fatal("stalled requests did not occupy both import slots")
		}
		time.Sleep(time.Millisecond)
	}
	// This complete chunked body must acquire a slot before reaching its size
	// limit. It needs no database and cannot pass while both slots stay held.
	postOversizedJSON(t, srv, token, -1)
	for _, conn := range stalled {
		response, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || response.StatusCode != http.StatusRequestTimeout {
			t.Fatalf("stalled upload response: status=%d body=%q err=%v", response.StatusCode, body, err)
		}
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

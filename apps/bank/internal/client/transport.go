package client

import (
	"fmt"
	"io"
	"net/http"
)

// InProcess is a client of handler in this process. A request is a call to
// the handler, with no socket in between, and carries no token: the handler
// decides what the caller may do.
func InProcess(handler http.Handler) *Client {
	return &Client{base: "http://bank", hc: &http.Client{Transport: handlerTransport{handler}}}
}

type handlerTransport struct{ handler http.Handler }

// RoundTrip serves req on another goroutine and answers once the handler has
// written its status. The body follows through a pipe rather than a buffer,
// because a download can be gigabytes.
func (t handlerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	served := req.Clone(req.Context())
	if served.Body == nil {
		served.Body = http.NoBody
	}
	served.RequestURI = req.URL.RequestURI()
	body, out := io.Pipe()
	w := &pipeResponse{header: http.Header{}, body: out, started: make(chan struct{})}
	go func() {
		defer served.Body.Close()
		t.handler.ServeHTTP(w, served)
		w.WriteHeader(http.StatusOK)
		out.Close()
	}()
	select {
	case <-w.started:
	case <-req.Context().Done():
		body.Close()
		return nil, req.Context().Err()
	}
	return &http.Response{
		Status: fmt.Sprintf("%d %s", w.status, http.StatusText(w.status)), StatusCode: w.status,
		Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1,
		Header: w.sent, Body: body, ContentLength: -1, Request: req,
	}, nil
}

type pipeResponse struct {
	header  http.Header
	sent    http.Header
	status  int
	body    *io.PipeWriter
	started chan struct{}
}

func (w *pipeResponse) Header() http.Header { return w.header }

func (w *pipeResponse) WriteHeader(status int) {
	if w.sent != nil {
		return
	}
	w.status, w.sent = status, w.header.Clone()
	close(w.started)
}

func (w *pipeResponse) Write(p []byte) (int, error) {
	w.WriteHeader(http.StatusOK)
	return w.body.Write(p)
}

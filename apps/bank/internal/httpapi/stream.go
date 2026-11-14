package httpapi

import (
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/danielgtaylor/huma/v2"
)

// Stream is embedded in an input whose body the handler reads as it arrives.
// Huma reads a body it knows into memory first, and a multipart form into
// memory or os.TempDir; an upload can be gigabytes, and the server's root
// filesystem is read-only. The operation documents its own RequestBody.
type Stream struct {
	ctx  huma.Context
	body io.Reader
	err  error
}

func (s *Stream) Resolve(ctx huma.Context) []error {
	s.ctx = ctx
	return nil
}

// Open limits the body to max bytes. Read it through Read.
func (s *Stream) Open(max int64) {
	s.body = http.MaxBytesReader(nil, io.NopCloser(s.ctx.BodyReader()), max)
}

func (s *Stream) Read(p []byte) (int, error) {
	n, err := s.body.Read(p)
	if err != nil && !errors.Is(err, io.EOF) {
		s.err = err
	}
	return n, err
}

// Multipart opens the body as multipart/form-data of at most max bytes.
func (s *Stream) Multipart(max int64) (*multipart.Reader, error) {
	mediaType, params, err := mime.ParseMediaType(s.ctx.Header("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" || params["boundary"] == "" {
		return nil, Invalid.New("the body must be multipart/form-data")
	}
	s.Open(max)
	return multipart.NewReader(s, params["boundary"]), nil
}

// ContentLength is the length the client declared, or -1.
func (s *Stream) ContentLength() int64 {
	n, err := strconv.ParseInt(s.ctx.Header("Content-Length"), 10, 64)
	if err != nil {
		return -1
	}
	return n
}

// SetReadDeadline bounds how long the body may take to arrive.
func (s *Stream) SetReadDeadline(deadline time.Time) error {
	return s.ctx.SetReadDeadline(deadline)
}

// Failed is the failure for a body that could not be read, and nil while
// every read has succeeded. A body that is too large, too slow or cut off is
// the caller's to fix.
func (s *Stream) Failed() error {
	if s.err == nil {
		return nil
	}
	if tooLarge, ok := errors.AsType[*http.MaxBytesError](s.err); ok {
		return Invalid.New(fmt.Sprintf("the body is larger than %d bytes", tooLarge.Limit))
	}
	if errors.Is(s.err, os.ErrDeadlineExceeded) {
		return Invalid.New("the body did not arrive in time")
	}
	return Invalid.New("reading the body: " + s.err.Error())
}

// Registered is the operation the document holds for method and path, which
// is also the one Huma serves it with. Huma reads any body an operation
// declares before registration, so a streamed body is documented through
// this afterwards.
func Registered(api huma.API, method, path string) *huma.Operation {
	item := api.OpenAPI().Paths[path]
	switch method {
	case http.MethodPost:
		return item.Post
	case http.MethodPut:
		return item.Put
	case http.MethodDelete:
		return item.Delete
	default:
		return item.Get
	}
}

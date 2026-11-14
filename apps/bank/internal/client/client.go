// Package client calls bank's API: a `bank serve` at BANK_URL, or the same
// handler served in this process. Every operation goes through Call, which
// encodes its input from the struct tags the server decodes it with, so the
// CLI behaves the same whichever of the two answers.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

type Client struct {
	base  string
	token string
	hc    *http.Client
}

func New(baseURL, token string) *Client {
	return &Client{base: strings.TrimSuffix(baseURL, "/"), token: token, hc: &http.Client{}}
}

// FromEnv returns a client for BANK_URL, or nil when none is set.
func FromEnv() *Client {
	base := os.Getenv("BANK_URL")
	if base == "" {
		return nil
	}
	return New(base, os.Getenv("BANK_TOKEN"))
}

// Call sends in to op and decodes the answer.
func Call[I, O any](ctx context.Context, c *Client, op httpapi.Op[I, O], in I) (O, error) {
	resp, err := c.send(ctx, op.Operation, in, nil, "")
	if err != nil {
		var zero O
		return zero, err
	}
	return decode[O](resp)
}

// Open sends in to op and returns the answer's bytes; the caller closes them.
func Open[I any](ctx context.Context, c *Client, op httpapi.StreamOp[I], in I) (io.ReadCloser, error) {
	resp, err := c.send(ctx, op.Operation, in, nil, "")
	if err != nil {
		return nil, err
	}
	return resp.Body, nil
}

// Upload sends in to op with a multipart/form-data body that parts writes as
// it is sent, so an input of any size streams.
func Upload[I, O any](ctx context.Context, c *Client, op httpapi.Op[I, O], in I, parts func(*multipart.Writer) error) (O, error) {
	pr, pw := io.Pipe()
	defer pr.Close()
	mw := multipart.NewWriter(pw)
	go func() {
		err := parts(mw)
		if err == nil {
			err = mw.Close()
		}
		pw.CloseWithError(err)
	}()
	resp, err := c.send(ctx, op.Operation, in, pr, mw.FormDataContentType())
	if err != nil {
		var zero O
		return zero, err
	}
	return decode[O](resp)
}

// ImportFile is the body of an import: the kind's options, then the input as
// the file field, which the server requires to come last.
func ImportFile(name string, r io.Reader, options json.RawMessage) func(*multipart.Writer) error {
	return func(mw *multipart.Writer) error {
		if len(options) == 0 {
			options = json.RawMessage(`{}`)
		}
		if err := mw.WriteField("options", string(options)); err != nil {
			return err
		}
		part, err := mw.CreateFormFile("file", name)
		if err != nil {
			return err
		}
		_, err = io.Copy(part, r)
		return err
	}
}

// Files is the body of a library upload: each path as a file field.
func Files(paths []string) func(*multipart.Writer) error {
	return func(mw *multipart.Writer) error {
		for _, path := range paths {
			if err := addFile(mw, path); err != nil {
				return err
			}
		}
		return nil
	}
}

func addFile(mw *multipart.Writer, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	part, err := mw.CreateFormFile("file", filepath.Base(path))
	if err != nil {
		return err
	}
	_, err = io.Copy(part, f)
	return err
}

func decode[O any](resp *http.Response) (O, error) {
	defer resp.Body.Close()
	var out O
	if resp.StatusCode == http.StatusNoContent {
		return out, nil
	}
	return out, json.NewDecoder(resp.Body).Decode(&out)
}

// send is every typed request's path: the input is encoded, and an answer
// that is not 2xx comes back as the error it stands for. A body given here
// replaces the one the input encodes.
func (c *Client) send(ctx context.Context, op httpapi.Operation, in any, body io.Reader, contentType string) (*http.Response, error) {
	r, err := encode(op, in)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", op.ID, err)
	}
	if body != nil {
		r.body, r.contentType = body, contentType
	}
	resp, err := c.do(ctx, op.Method, r)
	if failed, ok := errors.AsType[*Error](err); ok {
		return nil, failed.typed()
	}
	return resp, err
}

// Do sends a request that is already written, such as one built from an
// operation's document rather than its Go types, and returns the answer's
// JSON. A failure the server answered is an *Error that keeps its body.
func (c *Client) Do(ctx context.Context, method, path string, query url.Values, body json.RawMessage) (json.RawMessage, error) {
	r := request{path: path, query: query, header: http.Header{}}
	if body != nil {
		r.body, r.contentType = bytes.NewReader(body), "application/json"
	}
	resp, err := c.do(ctx, method, r)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	answer, err := io.ReadAll(resp.Body)
	return bytes.TrimSpace(answer), err
}

// do is every request's one path: the token goes on, and an answer that is
// not 2xx comes back as an *Error.
func (c *Client) do(ctx context.Context, method string, r request) (*http.Response, error) {
	u := c.base + r.path
	if len(r.query) > 0 {
		u += "?" + r.query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, r.body)
	if err != nil {
		return nil, err
	}
	req.Header = r.header
	if r.body != nil {
		req.Header.Set("Content-Type", r.contentType)
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		defer resp.Body.Close()
		return nil, decodeFailure(resp)
	}
	return resp, nil
}

// Error is a failure the server answered with, decoded from its tagged body.
// It unwraps to the sentinel error the store returns for the same failure, so
// a caller tests it the way it would test the store's. Body is the tagged
// JSON as the server sent it, fields of the failure's kind included.
type Error struct {
	Status   int
	Tag      string
	Message  string
	Recovery *httpapi.Recovery
	Body     json.RawMessage
	cause    error
}

func (e *Error) Error() string { return e.Message }
func (e *Error) Unwrap() error { return e.cause }

// failures maps each tag the server documents to the error the store returns
// for the same failure: a typed error is decoded from the body whole, so an
// ambiguous ref keeps its candidates, and a sentinel is what Error unwraps to.
// A tag without an entry stays an Error.
var failures = map[string]func(e *Error, body []byte) error{
	"NotFound":                is(store.ErrNotFound),
	"InvalidRequest":          is(fail.ErrInvalid),
	"LibraryRevisionConflict": is(library.ErrConflict),
	"AmbiguousRef":            as[store.AmbiguousRefError],
	"AmbiguousVolume":         as[store.AmbiguousVolumeError],
	"ScanRunning":             is(store.ErrScanRunning),
	"ClaimLost":               is(store.ErrClaimLost),
	"MessageRetired":          as[store.RetiredError],
	"MailThreadConflict":      as[store.MailThreadConflictError],
	"AliasTaken":              as[store.ErrConflict],
}

func is(sentinel error) func(*Error, []byte) error {
	return func(e *Error, _ []byte) error {
		e.cause = sentinel
		return e
	}
}

func as[T any, P interface {
	*T
	error
}](e *Error, body []byte) error {
	var v T
	if json.Unmarshal(body, &v) != nil {
		return e
	}
	return P(&v)
}

func decodeFailure(resp *http.Response) *Error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	e := &Error{Status: resp.StatusCode, Message: resp.Status}
	var tagged struct {
		Tag      string            `json:"_tag"`
		Message  string            `json:"message"`
		Recovery *httpapi.Recovery `json:"recovery"`
	}
	if json.Unmarshal(body, &tagged) != nil || tagged.Tag == "" {
		// Something between the client and bank serve answered, such as a proxy.
		if text := strings.TrimSpace(string(body)); text != "" {
			e.Message += ": " + text
		}
		return e
	}
	e.Tag, e.Message, e.Recovery, e.Body = tagged.Tag, tagged.Message, tagged.Recovery, bytes.TrimSpace(body)
	return e
}

// typed is the store's error for e, where its tag names one.
func (e *Error) typed() error {
	if typed, ok := failures[e.Tag]; ok {
		return typed(e, e.Body)
	}
	return e
}

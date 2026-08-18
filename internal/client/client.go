// Package client talks to a remote `bank serve`. It is what the CLI uses
// instead of Postgres when BANK_URL is set, so a laptop never ends up holding
// blobs for rows that live on the server.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/aquitano/aqt-bank/internal/generic"
	"github.com/aquitano/aqt-bank/internal/store"
)

type Client struct {
	base  string
	token string
	hc    *http.Client
}

func New(baseURL, token string) *Client {
	return &Client{base: strings.TrimSuffix(baseURL, "/"), token: token, hc: &http.Client{}}
}

// FromEnv returns a client for BANK_URL, or nil when the CLI should work locally.
func FromEnv() *Client {
	base := os.Getenv("BANK_URL")
	if base == "" {
		return nil
	}
	return New(base, os.Getenv("BANK_TOKEN"))
}

func (c *Client) request(ctx context.Context, method, path string, q url.Values, body io.Reader) (*http.Response, error) {
	u := c.base + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		defer resp.Body.Close()
		return nil, fmt.Errorf("%s %s: %s", method, path, errorMessage(resp))
	}
	return resp, nil
}

func errorMessage(resp *http.Response) string {
	var payload struct {
		Error string `json:"error"`
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	if json.Unmarshal(body, &payload) == nil && payload.Error != "" {
		return payload.Error
	}
	if len(body) == 0 {
		return resp.Status
	}
	return fmt.Sprintf("%s: %s", resp.Status, strings.TrimSpace(string(body)))
}

func getJSON[T any](ctx context.Context, c *Client, path string, q url.Values) (T, error) {
	var out T
	resp, err := c.request(ctx, http.MethodGet, path, q, nil)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	return out, json.NewDecoder(resp.Body).Decode(&out)
}

func (c *Client) Search(ctx context.Context, query string, o store.SearchOpts) ([]store.Message, error) {
	q := url.Values{"q": {query}}
	set := func(key, value string) {
		if value != "" {
			q.Set(key, value)
		}
	}
	set("source", o.Source)
	set("from", o.From)
	set("to", o.To)
	set("person", o.Person)
	if !o.Since.IsZero() {
		q.Set("since", o.Since.Format("2006-01-02"))
	}
	if !o.Until.IsZero() {
		q.Set("until", o.Until.Format("2006-01-02"))
	}
	q.Set("fuzzy", strconv.Itoa(o.Fuzzy))
	q.Set("limit", strconv.Itoa(o.Limit))
	if o.Offset > 0 {
		q.Set("offset", strconv.Itoa(o.Offset))
	}
	return getJSON[[]store.Message](ctx, c, "/v1/search", q)
}

func (c *Client) Message(ctx context.Context, id int64) (store.MessageDetail, error) {
	return getJSON[store.MessageDetail](ctx, c, "/v1/messages/"+strconv.FormatInt(id, 10), nil)
}

func (c *Client) Stats(ctx context.Context) ([]store.SourceStats, error) {
	return getJSON[[]store.SourceStats](ctx, c, "/v1/stats", nil)
}

// Thread fetches one conversation. An empty source lets the server resolve it,
// which fails when the thread id is used by more than one source.
func (c *Client) Thread(ctx context.Context, source, threadID string, limit int) (store.Thread, error) {
	q := url.Values{}
	if source != "" {
		q.Set("source", source)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	return getJSON[store.Thread](ctx, c, "/v1/threads/"+url.PathEscape(threadID), q)
}

func (c *Client) ListContacts(ctx context.Context) ([]store.Contact, error) {
	return getJSON[[]store.Contact](ctx, c, "/v1/contacts", nil)
}

// ContactDetail mirrors the server's contact payload: the contact plus where
// its messages actually are.
type ContactDetail struct {
	store.Contact
	Sources []store.ContactSourceCount `json:"sources"`
}

func (c *Client) Contact(ctx context.Context, name string) (ContactDetail, error) {
	return getJSON[ContactDetail](ctx, c, "/v1/contacts/"+url.PathEscape(name), nil)
}

func (c *Client) ContactMessages(ctx context.Context, name string, o store.ContactMessagesOpts) ([]store.Message, error) {
	q := url.Values{}
	if o.Source != "" {
		q.Set("source", o.Source)
	}
	if !o.Since.IsZero() {
		q.Set("since", o.Since.Format("2006-01-02"))
	}
	if !o.Until.IsZero() {
		q.Set("until", o.Until.Format("2006-01-02"))
	}
	if o.Limit > 0 {
		q.Set("limit", strconv.Itoa(o.Limit))
	}
	if o.Offset > 0 {
		q.Set("offset", strconv.Itoa(o.Offset))
	}
	return getJSON[[]store.Message](ctx, c, "/v1/contacts/"+url.PathEscape(name)+"/messages", q)
}

func (c *Client) SuggestIdentities(ctx context.Context, limit int) ([]store.IdentitySuggestion, error) {
	q := url.Values{}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	return getJSON[[]store.IdentitySuggestion](ctx, c, "/v1/contacts/suggest", q)
}

func (c *Client) CreateContact(ctx context.Context, name, note string) (store.Contact, error) {
	return postJSON[store.Contact](ctx, c, "/v1/contacts", nil,
		map[string]string{"name": name, "note": note})
}

func (c *Client) DeleteContact(ctx context.Context, name string) error {
	resp, err := c.request(ctx, http.MethodDelete, "/v1/contacts/"+url.PathEscape(name), nil, nil)
	if err != nil {
		return err
	}
	return resp.Body.Close()
}

func (c *Client) AddAlias(ctx context.Context, name, source, value string) (store.ContactAlias, error) {
	return postJSON[store.ContactAlias](ctx, c, "/v1/contacts/"+url.PathEscape(name)+"/aliases", nil,
		map[string]string{"source": source, "value": value})
}

func (c *Client) RemoveAlias(ctx context.Context, name, source, value string) error {
	q := url.Values{"value": {value}}
	if source != "" {
		q.Set("source", source)
	}
	resp, err := c.request(ctx, http.MethodDelete, "/v1/contacts/"+url.PathEscape(name)+"/aliases", q, nil)
	if err != nil {
		return err
	}
	return resp.Body.Close()
}

func postJSON[T any](ctx context.Context, c *Client, path string, q url.Values, payload any) (T, error) {
	var out T
	body, err := json.Marshal(payload)
	if err != nil {
		return out, err
	}
	resp, err := c.request(ctx, http.MethodPost, path, q, bytes.NewReader(body))
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	return out, json.NewDecoder(resp.Body).Decode(&out)
}

// Blob streams an attachment; the caller closes the returned reader.
func (c *Client) Blob(ctx context.Context, sha256 string) (io.ReadCloser, error) {
	resp, err := c.request(ctx, http.MethodGet, "/v1/blobs/"+sha256, nil, nil)
	if err != nil {
		return nil, err
	}
	return resp.Body, nil
}

func (c *Client) ImportJSON(ctx context.Context, source string, body []byte) (generic.Result, error) {
	q := url.Values{}
	if source != "" {
		q.Set("source", source)
	}
	resp, err := c.request(ctx, http.MethodPost, "/v1/import/json", q, bytes.NewReader(body))
	if err != nil {
		return generic.Result{}, err
	}
	defer resp.Body.Close()
	var res generic.Result
	return res, json.NewDecoder(resp.Body).Decode(&res)
}

// ImportFile uploads one file and decodes that importer's Result, e.g.
// ImportFile[whatsapp.Result](ctx, c, "whatsapp", "", path).
func ImportFile[T any](ctx context.Context, c *Client, kind, source, path string) (T, error) {
	var res T
	f, err := os.Open(path)
	if err != nil {
		return res, err
	}
	defer f.Close()

	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go func() {
		part, err := mw.CreateFormFile("file", filepath.Base(path))
		if err == nil {
			_, err = io.Copy(part, f)
		}
		if err == nil {
			err = mw.Close()
		}
		pw.CloseWithError(err)
	}()

	q := url.Values{}
	if source != "" {
		q.Set("source", source)
	}
	u := c.base + "/v1/import/" + kind
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, pr)
	if err != nil {
		return res, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := c.hc.Do(req)
	if err != nil {
		return res, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return res, fmt.Errorf("import %s: %s", kind, errorMessage(resp))
	}
	return res, json.NewDecoder(resp.Body).Decode(&res)
}

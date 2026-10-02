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

	"github.com/aquitano/aqt/apps/bank/internal/archive"

	"github.com/aquitano/aqt/apps/bank/internal/generic"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

type Client struct {
	base  string
	token string
	hc    *http.Client
	// tempDir stages blob downloads for extraction; see SetTempDir.
	tempDir string
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
		if resp.StatusCode == http.StatusConflict {
			var conflict store.MailThreadConflictError
			if err := json.NewDecoder(io.LimitReader(resp.Body, 65536)).Decode(&conflict); err == nil && conflict.Code == "mail_thread_conflict" {
				return nil, &conflict
			}
			return nil, fmt.Errorf("%s %s: conflicting mail conversation", method, path)
		}
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
	set("subject", o.Subject)
	if o.MailboxID != 0 {
		set("mailbox_id", strconv.FormatInt(o.MailboxID, 10))
	}
	if o.HasAttachment != nil {
		set("has_attachment", strconv.FormatBool(*o.HasAttachment))
	}
	set("from", o.From)
	set("to", o.To)
	set("person", o.Person)
	set("match", o.Match)
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

func (c *Client) GetMessageDetail(ctx context.Context, id int64) (store.MessageDetail, error) {
	return getJSON[store.MessageDetail](ctx, c, "/v1/messages/"+strconv.FormatInt(id, 10), nil)
}

// GetMessageDetailByRef fetches a message by its stable ref; the same endpoint
// takes either form.
func (c *Client) GetMessageDetailByRef(ctx context.Context, ref string) (store.MessageDetail, error) {
	if err := store.ValidRef(ref); err != nil {
		return store.MessageDetail{}, err
	}
	return getJSON[store.MessageDetail](ctx, c, "/v1/messages/"+ref, nil)
}

func (c *Client) Stats(ctx context.Context) ([]store.SourceStats, error) {
	return getJSON[[]store.SourceStats](ctx, c, "/v1/stats", nil)
}

// SetCoverage records what a source is known to hold; an empty text clears it.
func (c *Client) SetCoverage(ctx context.Context, source, text string) error {
	body, err := json.Marshal(map[string]string{"text": text})
	if err != nil {
		return err
	}
	resp, err := c.request(ctx, http.MethodPut,
		"/v1/sources/"+url.PathEscape(source)+"/coverage", nil, bytes.NewReader(body))
	if err != nil {
		return err
	}
	return resp.Body.Close()
}

// Thread fetches one conversation. An empty source lets the server resolve it,
// which fails when the thread id is used by more than one source.
func (c *Client) GetThreadPage(ctx context.Context, source, threadID string, o store.ThreadOpts) (store.Thread, error) {
	q := url.Values{}
	if source != "" {
		q.Set("source", source)
	}
	if err := o.Validate(); err != nil {
		return store.Thread{}, err
	}
	q.Set("limit", strconv.Itoa(o.Limit))
	for name, id := range map[string]int64{"before": o.Before, "after": o.After, "around": o.Around} {
		if id > 0 {
			q.Set(name, strconv.FormatInt(id, 10))
		}
	}
	if o.Current {
		q.Set("current", "true")
	}
	if o.Latest {
		q.Set("latest", "true")
	}
	return getJSON[store.Thread](ctx, c, "/v1/threads/"+url.PathEscape(threadID), q)
}

func (c *Client) ListContacts(ctx context.Context) ([]store.Contact, error) {
	return getJSON[[]store.Contact](ctx, c, "/v1/contacts", nil)
}

func (c *Client) GetContactDetail(ctx context.Context, name string) (store.ContactDetail, error) {
	return getJSON[store.ContactDetail](ctx, c, "/v1/contacts/"+url.PathEscape(name), nil)
}

func (c *Client) ContactMessages(ctx context.Context, name string, o store.ContactMessagesOpts) ([]store.MessageDetail, error) {
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
	if o.Before > 0 {
		q.Set("before", strconv.FormatInt(o.Before, 10))
	}
	return getJSON[[]store.MessageDetail](ctx, c, "/v1/contacts/"+url.PathEscape(name)+"/messages", q)
}

// Query runs one read-only ad-hoc SQL statement on the server (POST /v1/query).
func (c *Client) Query(ctx context.Context, query string, limit int) (store.QueryResult, error) {
	return postJSON[store.QueryResult](ctx, c, "/v1/query", nil,
		map[string]any{"sql": query, "limit": limit})
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

func (c *Client) ImportContacts(ctx context.Context, in []store.ContactImport) ([]store.ContactImportResult, error) {
	return postJSON[[]store.ContactImportResult](ctx, c, "/v1/contacts/import", nil, in)
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
func ImportFile[T any](ctx context.Context, c *Client, kind, source, path string, contexts ...*archive.MailImportContext) (T, error) {
	var res T
	var contextJSON []byte
	if len(contexts) > 1 {
		return res, fmt.Errorf("only one mail context is allowed")
	}
	if len(contexts) == 1 && contexts[0] != nil {
		if kind != "eml" && kind != "mbox" {
			return res, fmt.Errorf("mail context requires an EML or MBOX import")
		}
		if err := contexts[0].Validate(); err != nil {
			return res, err
		}
		var err error
		contextJSON, err = json.Marshal(contexts[0])
		if err != nil {
			return res, err
		}
		if len(contextJSON) > archive.MaxMailContextBytes {
			return res, fmt.Errorf("mail context is too large")
		}
	}
	f, err := os.Open(path)
	if err != nil {
		return res, err
	}
	defer f.Close()

	pr, pw := io.Pipe()
	defer pr.Close()
	mw := multipart.NewWriter(pw)
	go func() {
		if contextJSON != nil {
			if err := mw.WriteField("mail_context", string(contextJSON)); err != nil {
				_ = pw.CloseWithError(err)
				return
			}
		}
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
	var raw json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return res, err
	}
	if contextJSON != nil {
		var ack struct {
			Version int `json:"mail_context_version"`
		}
		if err := json.Unmarshal(raw, &ack); err != nil || ack.Version != 1 {
			return res, fmt.Errorf("server did not acknowledge mail context version 1; upgrade Bank before retrying")
		}
	}
	return res, json.Unmarshal(raw, &res)
}

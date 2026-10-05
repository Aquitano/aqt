package client

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// The extract.Archive side of the client. Implementing it here is what lets
// `bank extract` run on a laptop against a remote archive: the heavy tools
// (tesseract, or any model of your own) live where you actually installed
// them, while rows and text stay on the server.

func (c *Client) ListBlobs(ctx context.Context, o store.ListBlobsOpts) ([]store.BlobRef, error) {
	q := url.Values{}
	if len(o.Statuses) > 0 {
		q.Set("status", strings.Join(o.Statuses, ","))
	}
	if o.Source != "" {
		q.Set("source", o.Source)
	}
	if o.Limit > 0 {
		q.Set("limit", strconv.Itoa(o.Limit))
	}
	return getJSON[[]store.BlobRef](ctx, c, "/v1/attachments", q)
}

func (c *Client) ExtractionStats(ctx context.Context) ([]store.ExtractionStat, error) {
	return getJSON[[]store.ExtractionStat](ctx, c, "/v1/attachments/stats", nil)
}

func (c *Client) BlobText(ctx context.Context, sha256 string) (store.BlobText, error) {
	return getJSON[store.BlobText](ctx, c, "/v1/attachments/"+sha256+"/text", nil)
}

func (c *Client) PutBlobText(ctx context.Context, bt store.BlobText) error {
	q := url.Values{"status": {bt.Status}}
	if bt.Extractor != "" {
		q.Set("extractor", bt.Extractor)
	}
	resp, err := c.request(ctx, http.MethodPut, "/v1/attachments/"+bt.SHA256+"/text", q,
		strings.NewReader(bt.Text))
	if err != nil {
		return err
	}
	return resp.Body.Close()
}

// SetText is PutBlobText for a transcription: the server validates the digest
// and defaults the status to "manual".
func (c *Client) SetText(ctx context.Context, bt store.BlobText) error {
	return c.PutBlobText(ctx, bt)
}

func (c *Client) DeleteBlobText(ctx context.Context, sha256 string) error {
	resp, err := c.request(ctx, http.MethodDelete, "/v1/attachments/"+sha256+"/text", nil, nil)
	if err != nil {
		return err
	}
	return resp.Body.Close()
}

func (c *Client) RefreshAttachmentText(ctx context.Context, since time.Time) (int64, error) {
	q := url.Values{}
	if !since.IsZero() {
		q.Set("since", since.Format(time.RFC3339Nano))
	}
	resp, err := c.request(ctx, http.MethodPost, "/v1/attachments/refresh", q, nil)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	var out struct {
		Reindexed int64 `json:"messages_reindexed"`
	}
	return out.Reindexed, json.NewDecoder(resp.Body).Decode(&out)
}

// OpenBlob downloads the bytes to a temp file, because the extractors seek and
// the OCR tools are subprocesses that take a path. The caller's cleanup
// removes it.
func (c *Client) OpenBlob(ctx context.Context, sha256 string) (string, func(), error) {
	body, err := c.Blob(ctx, sha256)
	if err != nil {
		return "", func() {}, err
	}
	defer body.Close()

	f, err := os.CreateTemp(c.tempDir, "blob-*")
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() { os.Remove(f.Name()) }
	_, err = io.Copy(f, body)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		cleanup()
		return "", func() {}, err
	}
	return f.Name(), cleanup, nil
}

// SetTempDir chooses where OpenBlob stages downloads. The CLI points it at the
// data directory: attachments run to hundreds of megabytes, and the deployed
// container's /tmp is a small tmpfs.
func (c *Client) SetTempDir(dir string) { c.tempDir = dir }

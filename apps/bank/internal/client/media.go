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
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/mediaimport"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

func libraryQuery(o library.ListOptions) url.Values {
	q := url.Values{"q": {o.Query}, "match": {o.Match}, "source": {o.Source}, "account": {o.Account}, "kind": {o.Kind}, "item_id": {o.ItemID}, "since": {o.Since}, "until": {o.Until}, "offset": {strconv.Itoa(o.Offset)}}
	if o.Limit > 0 {
		q.Set("limit", strconv.Itoa(o.Limit))
	}
	return q
}

func (c *Client) ListLibraryItems(ctx context.Context, o library.ListOptions) ([]library.Item, error) {
	return getJSON[[]library.Item](ctx, c, "/v1/library/items", libraryQuery(o))
}
func (c *Client) ListLibraryActivity(ctx context.Context, o library.ListOptions) ([]library.Activity, error) {
	return getJSON[[]library.Activity](ctx, c, "/v1/library/activity", libraryQuery(o))
}
func (c *Client) ListLibraryCollections(ctx context.Context, o library.ListOptions) ([]library.Collection, error) {
	q := libraryQuery(o)
	q.Set("projection", "full")
	return getJSON[[]library.Collection](ctx, c, "/v1/library/collections", q)
}
func (c *Client) ListLibraryCollectionSummaries(ctx context.Context, o library.ListOptions) ([]library.CollectionSummary, error) {
	return getJSON[[]library.CollectionSummary](ctx, c, "/v1/library/collections", libraryQuery(o))
}
func (c *Client) ListLibraryFiles(ctx context.Context, o library.ListOptions) ([]library.File, error) {
	return getJSON[[]library.File](ctx, c, "/v1/library/files", libraryQuery(o))
}
func (c *Client) LibraryItem(ctx context.Context, id string) (library.Item, error) {
	return getJSON[library.Item](ctx, c, "/v1/library/items/"+url.PathEscape(id), nil)
}
func (c *Client) LibraryCollection(ctx context.Context, id string) (library.Collection, error) {
	return getJSON[library.Collection](ctx, c, "/v1/library/collections/"+url.PathEscape(id), nil)
}
func (c *Client) LibraryCollectionSnapshots(ctx context.Context, id string) ([]library.Snapshot, error) {
	return getJSON[[]library.Snapshot](ctx, c, "/v1/library/collections/"+url.PathEscape(id)+"/snapshots", url.Values{"projection": {"full"}})
}
func (c *Client) LibraryCollectionSnapshotSummaries(ctx context.Context, id string, o library.ListOptions) ([]library.SnapshotSummary, error) {
	return getJSON[[]library.SnapshotSummary](ctx, c, "/v1/library/collections/"+url.PathEscape(id)+"/snapshots", libraryQuery(o))
}
func (c *Client) LibraryCollectionSnapshot(ctx context.Context, id string, snapshotID int64) (library.Snapshot, error) {
	return getJSON[library.Snapshot](ctx, c, "/v1/library/collections/"+url.PathEscape(id)+"/snapshots/"+strconv.FormatInt(snapshotID, 10), nil)
}
func (c *Client) LibraryItemSummaries(ctx context.Context, ids []string) ([]library.ItemSummary, error) {
	request := library.ItemSummaryRequest{IDs: ids}
	if err := request.Validate(); err != nil {
		return nil, err
	}
	return postJSON[[]library.ItemSummary](ctx, c, "/v1/library/items/summaries", nil, request)
}
func (c *Client) LibraryFile(ctx context.Context, id string) (library.File, error) {
	return getJSON[library.File](ctx, c, "/v1/library/files/"+url.PathEscape(id), nil)
}
func (c *Client) LibraryPage(ctx context.Context, id string) (library.Page, error) {
	return getJSON[library.Page](ctx, c, "/v1/library/pages/"+url.PathEscape(id), nil)
}
func (c *Client) SearchLibrary(ctx context.Context, o library.ListOptions) (library.SearchResult, error) {
	return getJSON[library.SearchResult](ctx, c, "/v1/library/search", libraryQuery(o))
}
func (c *Client) CreateLibraryItem(ctx context.Context, item library.Item) (library.Item, error) {
	return postJSON[library.Item](ctx, c, "/v1/library/items", nil, item)
}
func (c *Client) CreateLibraryCollection(ctx context.Context, value library.Collection) (library.Collection, error) {
	return postJSON[library.Collection](ctx, c, "/v1/library/collections", nil, value)
}

func putLibraryJSON[T any](ctx context.Context, c *Client, path string, value any) (T, error) {
	var result T
	raw, err := json.Marshal(value)
	if err != nil {
		return result, err
	}
	resp, err := c.request(ctx, http.MethodPut, path, nil, bytes.NewReader(raw))
	if err != nil {
		return result, err
	}
	defer resp.Body.Close()
	return result, json.NewDecoder(resp.Body).Decode(&result)
}
func (c *Client) SetLibraryState(ctx context.Context, id string, edit library.StateEdit) (library.State, error) {
	return putLibraryJSON[library.State](ctx, c, "/v1/library/items/"+url.PathEscape(id)+"/state", edit)
}
func (c *Client) EditLibraryCollection(ctx context.Context, id string, edit library.CollectionEdit) (library.Collection, error) {
	return putLibraryJSON[library.Collection](ctx, c, "/v1/library/collections/"+url.PathEscape(id), edit)
}

func (c *Client) Find(ctx context.Context, query string, messages store.SearchOpts, o library.ListOptions) (catalog.Result, error) {
	o.Query = query
	q := libraryQuery(o)
	q.Set("source", messages.Source)
	q.Set("from", messages.From)
	q.Set("to", messages.To)
	q.Set("person", messages.Person)
	q.Set("subject", messages.Subject)
	q.Set("match", messages.Match)
	q.Set("fuzzy", strconv.Itoa(messages.Fuzzy))
	if messages.MailboxID != 0 {
		q.Set("mailbox_id", strconv.FormatInt(messages.MailboxID, 10))
	}
	if messages.HasAttachment != nil {
		q.Set("has_attachment", strconv.FormatBool(*messages.HasAttachment))
	}
	if !messages.Since.IsZero() {
		q.Set("since", messages.Since.Format(time.RFC3339Nano))
	}
	if !messages.Until.IsZero() {
		q.Set("until", messages.Until.Format(time.RFC3339Nano))
	}
	return getJSON[catalog.Result](ctx, c, "/v1/find", q)
}

func (c *Client) UploadLibraryFiles(ctx context.Context, paths []string, source, account, itemID string) ([]library.File, error) {
	result := []library.File{}
	if len(paths) == 0 || len(paths) > 100 {
		return result, fmt.Errorf("upload requires 1-100 files")
	}
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			return result, err
		}
		if !info.Mode().IsRegular() {
			return result, fmt.Errorf("not a regular file: %s", path)
		}
	}
	reader, writer := io.Pipe()
	defer reader.Close()
	multipartWriter := multipart.NewWriter(writer)
	go func() {
		var uploadErr error
		for _, path := range paths {
			part, err := multipartWriter.CreateFormFile("file", filepath.Base(path))
			if err != nil {
				uploadErr = err
				break
			}
			file, err := os.Open(path)
			if err != nil {
				uploadErr = err
				break
			}
			_, err = io.Copy(part, file)
			closeErr := file.Close()
			if err != nil {
				uploadErr = err
				break
			}
			if closeErr != nil {
				uploadErr = closeErr
				break
			}
		}
		if uploadErr == nil {
			uploadErr = multipartWriter.Close()
		}
		writer.CloseWithError(uploadErr)
	}()
	q := url.Values{"source": {source}, "account": {account}, "item_id": {itemID}}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/v1/library/files?"+q.Encode(), reader)
	if err != nil {
		return result, err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Content-Type", multipartWriter.FormDataContentType())
	response, err := c.hc.Do(request)
	if err != nil {
		return result, err
	}
	defer response.Body.Close()
	if response.StatusCode/100 != 2 {
		return result, fmt.Errorf("upload library files: %s", errorMessage(response))
	}
	return result, json.NewDecoder(response.Body).Decode(&result)
}

func (c *Client) PublishLibraryPages(ctx context.Context, publication mediaimport.Publication) (mediaimport.Result, error) {
	return postJSON[mediaimport.Result](ctx, c, "/v1/library/pages/publication", nil, publication)
}

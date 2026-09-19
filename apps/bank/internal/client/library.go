package client

import (
	"context"
	"net/url"
	"strconv"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/store"
)

func (c *Client) ImportReports(ctx context.Context, before int64, limit int) ([]store.ImportReport, error) {
	return getJSON[[]store.ImportReport](ctx, c, "/v1/import-reports", url.Values{"before": {strconv.FormatInt(before, 10)}, "limit": {strconv.Itoa(limit)}})
}
func (c *Client) AttachmentLibrary(ctx context.Context, o store.AttachmentFilter) ([]store.LibraryFile, error) {
	q := url.Values{"q": {o.Filename}, "type": {o.FileType}, "person": {o.Person}, "offset": {strconv.Itoa(o.Offset)}, "limit": {strconv.Itoa(o.Limit)}}
	if !o.Since.IsZero() {
		q.Set("since", o.Since.Format(time.RFC3339))
	}
	if !o.Until.IsZero() {
		q.Set("until", o.Until.Format(time.RFC3339))
	}
	return getJSON[[]store.LibraryFile](ctx, c, "/v1/attachment-library", q)
}
func (c *Client) AttachmentMessages(ctx context.Context, sum string, offset, limit int) ([]store.Message, error) {
	return getJSON[[]store.Message](ctx, c, "/v1/attachments/"+sum+"/messages", url.Values{"offset": {strconv.Itoa(offset)}, "limit": {strconv.Itoa(limit)}})
}

package client

import (
	"context"
	"net/url"
	"strconv"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/store"
)

func (c *Client) ListMailboxes(ctx context.Context, source string) ([]store.Mailbox, error) {
	return getJSON[[]store.Mailbox](ctx, c, "/v1/mailboxes", url.Values{"source": {source}})
}

func (c *Client) MailConflictMessages(ctx context.Context, source, key string, before int64, limit int) (store.Thread, error) {
	return getJSON[store.Thread](ctx, c, "/v1/mail-conflicts/"+url.PathEscape(key), url.Values{"source": {source}, "before": {strconv.FormatInt(before, 10)}, "limit": {strconv.Itoa(limit)}})
}

func (c *Client) BrowseThreads(ctx context.Context, options store.BrowseOpts) ([]store.ThreadGroup, error) {
	if err := options.Validate(); err != nil {
		return nil, err
	}
	query := url.Values{"source": {options.Source}, "order": {options.Order}, "limit": {strconv.Itoa(options.Limit)}, "offset": {strconv.Itoa(options.Offset)}, "subject": {options.Subject}, "from": {options.From}, "to": {options.To}, "person": {options.Person}}
	if options.MailboxID != 0 {
		query.Set("mailbox_id", strconv.FormatInt(options.MailboxID, 10))
	}
	if options.HasAttachment != nil {
		query.Set("has_attachment", strconv.FormatBool(*options.HasAttachment))
	}
	if !options.Since.IsZero() {
		query.Set("since", options.Since.Format(time.RFC3339))
	}
	if !options.Until.IsZero() {
		query.Set("until", options.Until.Format(time.RFC3339))
	}
	return getJSON[[]store.ThreadGroup](ctx, c, "/v1/threads", query)
}

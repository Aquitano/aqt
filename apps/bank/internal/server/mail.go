package server

import (
	"fmt"
	"net/url"
	"strconv"
)

func parseMailFilters(query url.Values) (int64, string, *bool, error) {
	var mailboxID int64
	var attachment *bool
	if raw := query.Get("mailbox_id"); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id <= 0 || query.Get("source") == "" {
			return 0, "", nil, fmt.Errorf("mailbox_id must be positive and requires a source")
		}
		mailboxID = id
	}
	if query.Has("has_attachment") {
		raw := query.Get("has_attachment")
		if raw != "true" && raw != "false" {
			return 0, "", nil, fmt.Errorf("has_attachment must be true or false")
		}
		value := raw == "true"
		attachment = &value
	}
	return mailboxID, query.Get("subject"), attachment, nil
}

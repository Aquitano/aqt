package gmail

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// apiBase is a var so tests can point the client at an httptest server; the
// sync logic is where the interesting failure modes live and it is not worth
// mocking at a coarser grain.
var apiBase = "https://gmail.googleapis.com/gmail/v1/users/me"

// retryBase is the unit of the exponential backoff between retries; tests
// shrink it so a deliberately failing endpoint does not cost 14 seconds.
var retryBase = time.Second

type client struct {
	http *http.Client
}

func newClient(ctx context.Context, dataDir string) (*client, error) {
	hc, err := httpClient(ctx, dataDir)
	if err != nil {
		return nil, err
	}
	return &client{http: hc}, nil
}

// errNotFound distinguishes an expired startHistoryId (404) from real failures.
var errNotFound = fmt.Errorf("not found")

func (c *client) getJSON(ctx context.Context, path string, out any) error {
	var lastErr error
	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(time.Duration(1<<attempt) * retryBase):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiBase+path, nil)
		if err != nil {
			return err
		}
		resp, err := c.http.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		switch {
		case resp.StatusCode == http.StatusOK && err == nil:
			return json.Unmarshal(body, out)
		case resp.StatusCode == http.StatusNotFound:
			return errNotFound
		case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
			lastErr = fmt.Errorf("gmail api %d: %s", resp.StatusCode, firstLine(body))
			continue
		default:
			return fmt.Errorf("gmail api %d: %s", resp.StatusCode, firstLine(body))
		}
	}
	return lastErr
}

func firstLine(b []byte) string {
	s := strings.TrimSpace(string(b))
	if i := strings.IndexByte(s, '\n'); i > 0 {
		s = s[:i]
	}
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

type profile struct {
	EmailAddress string `json:"emailAddress"`
	HistoryID    string `json:"historyId"`
}

func (c *client) profile(ctx context.Context) (profile, error) {
	var p profile
	err := c.getJSON(ctx, "/profile", &p)
	return p, err
}

// listMessageIDs walks the full mailbox (newest first), calling fn per id.
func (c *client) listMessageIDs(ctx context.Context, fn func(id string) error) error {
	pageToken := ""
	for {
		path := "/messages?maxResults=500"
		if pageToken != "" {
			path += "&pageToken=" + url.QueryEscape(pageToken)
		}
		var page struct {
			Messages []struct {
				ID string `json:"id"`
			} `json:"messages"`
			NextPageToken string `json:"nextPageToken"`
		}
		if err := c.getJSON(ctx, path, &page); err != nil {
			return err
		}
		for _, m := range page.Messages {
			if err := fn(m.ID); err != nil {
				return err
			}
		}
		if page.NextPageToken == "" {
			return nil
		}
		pageToken = page.NextPageToken
	}
}

type rawMessage struct {
	ID           string
	ThreadID     string
	Raw          []byte
	InternalDate time.Time
}

func (c *client) getRaw(ctx context.Context, id string) (rawMessage, error) {
	var resp struct {
		ID           string `json:"id"`
		ThreadID     string `json:"threadId"`
		InternalDate string `json:"internalDate"`
		Raw          string `json:"raw"`
	}
	if err := c.getJSON(ctx, "/messages/"+id+"?format=raw", &resp); err != nil {
		return rawMessage{}, err
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(resp.Raw, "="))
	if err != nil {
		return rawMessage{}, fmt.Errorf("message %s: %w", id, err)
	}
	out := rawMessage{ID: resp.ID, ThreadID: resp.ThreadID, Raw: raw}
	if ms, err := strconv.ParseInt(resp.InternalDate, 10, 64); err == nil {
		out.InternalDate = time.UnixMilli(ms)
	}
	return out, nil
}

// listHistory returns message ids added since startHistoryID and the new
// history id. A second return of false means the start id has expired and the
// caller must fall back to a full listing.
func (c *client) listHistory(ctx context.Context, startHistoryID string) ([]string, string, bool, error) {
	seen := map[string]bool{}
	var ids []string
	newHistoryID := ""
	pageToken := ""
	for {
		path := "/history?historyTypes=messageAdded&maxResults=500&startHistoryId=" + url.QueryEscape(startHistoryID)
		if pageToken != "" {
			path += "&pageToken=" + url.QueryEscape(pageToken)
		}
		var page struct {
			History []struct {
				MessagesAdded []struct {
					Message struct {
						ID string `json:"id"`
					} `json:"message"`
				} `json:"messagesAdded"`
			} `json:"history"`
			HistoryID     string `json:"historyId"`
			NextPageToken string `json:"nextPageToken"`
		}
		err := c.getJSON(ctx, path, &page)
		if err == errNotFound {
			return nil, "", false, nil
		}
		if err != nil {
			return nil, "", true, err
		}
		if page.HistoryID != "" {
			newHistoryID = page.HistoryID
		}
		for _, h := range page.History {
			for _, ma := range h.MessagesAdded {
				if id := ma.Message.ID; id != "" && !seen[id] {
					seen[id] = true
					ids = append(ids, id)
				}
			}
		}
		if page.NextPageToken == "" {
			return ids, newHistoryID, true, nil
		}
		pageToken = page.NextPageToken
	}
}

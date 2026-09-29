// Package x reads a status page on X (formerly Twitter) out of the rendered
// DOM the extension captures: X ships an empty shell to any plain fetch, so
// every selector here targets data-testid attributes rather than markup that
// only exists after hydration.
package x

import (
	"bytes"
	"context"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/html"

	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
)

const Name = "x"

func init() { extractor.Register(Extractor{}) }

type Extractor struct{}

type Image struct {
	URL     string `json:"url"`
	AltText string `json:"alt_text"`
}

type Data struct {
	PostURL         string  `json:"post_url"`
	Images          []Image `json:"images"`
	StatusID        string  `json:"status_id"`
	AuthorHandle    string  `json:"author_handle"`
	AuthorName      string  `json:"author_name"`
	Text            string  `json:"text"`
	PostedAt        string  `json:"posted_at"`
	ReplyToStatusID string  `json:"reply_to_status_id,omitempty"`
	QuotedStatusID  string  `json:"quoted_status_id,omitempty"`
	MediaCount      int     `json:"media_count"`
	Lang            string  `json:"lang,omitempty"`
}

const titleRunes = 80

func (Extractor) Rule() extractor.Rule {
	return extractor.Rule{
		Extractor: Name,
		Version:   3,
		// Every subdomain, so X Pro's columns of notifications and messages
		// never fall through to the article fallback.
		Hosts:     []string{"x.com", "*.x.com", "twitter.com", "*.twitter.com"},
		PathRegex: `^/[^/]+/status/\d+`,
		Recapture: extractor.RecaptureAfterQuiet,
	}
}

func (Extractor) Extract(_ context.Context, raw []byte, pageURL *url.URL) (extractor.Record, error) {
	_, statusID := linkStatus(pageURL.Path)
	if statusID == "" {
		return extractor.Record{}, extractor.ErrNoMatch
	}
	doc, err := html.Parse(bytes.NewReader(raw))
	if err != nil {
		return extractor.Record{}, err
	}

	articles := findAll(doc, nil, func(n *html.Node) bool { return testID(n, "tweet") })
	focal, before := focalArticle(articles, statusID)
	if focal == nil {
		return extractor.Record{}, extractor.ErrNoMatch
	}

	quote := find(focal, nil, isQuoteCard)
	body := find(focal, quote, func(n *html.Node) bool { return testID(n, "tweetText") })
	images := postImages(focal, quote)
	if body == nil && len(images) == 0 {
		return extractor.Record{}, extractor.ErrNoMatch
	}

	handle, name := author(focal, quote)
	if handle == "" {
		handle, _ = linkStatus(pageURL.Path)
	}
	postURL := "https://x.com/" + handle + "/status/" + statusID
	data := Data{
		PostURL:         postURL,
		Images:          images,
		StatusID:        statusID,
		AuthorHandle:    handle,
		AuthorName:      name,
		Text:            text(body, nil),
		PostedAt:        postedAt(focal, quote),
		ReplyToStatusID: replyTo(before, statusID),
		QuotedStatusID:  quotedStatusID(quote),
		MediaCount:      len(findAll(focal, quote, isMedia)),
		Lang:            attr(body, "lang"),
	}

	search := []string{data.AuthorHandle, data.AuthorName, data.Text}
	titleText := data.Text
	for _, image := range images {
		if alt := strings.TrimSpace(image.AltText); alt != "" && !strings.EqualFold(alt, "Image") {
			search = append(search, alt)
			if titleText == "" {
				titleText = alt
			}
		}
	}
	if titleText == "" {
		titleText = "Photo post"
	}
	title := "@" + data.AuthorHandle + ": " + firstRunes(collapse(titleText), titleRunes)
	return extractor.Record{
		CanonicalURL: postURL,
		Title:        title,
		SearchText:   strings.TrimSpace(strings.Join(search, "\n")),
		Data:         data,
	}, nil
}

func postImages(focal, quote *html.Node) []Image {
	images := []Image{}
	seen := map[string]bool{}
	for _, photo := range findAll(focal, quote, func(n *html.Node) bool { return testID(n, "tweetPhoto") }) {
		for _, img := range findAll(photo, nil, func(n *html.Node) bool { return isElem(n, "img") }) {
			u, err := url.Parse(attr(img, "src"))
			if err != nil || u.Scheme != "https" || u.Host != "pbs.twimg.com" || !strings.HasPrefix(u.Path, "/media/") {
				continue
			}
			// X picks name=small|medium|large from the rendered size, so the
			// same post seen on two screens would hash as two records.
			q := url.Values{"name": {"orig"}}
			if format := u.Query().Get("format"); format != "" {
				q.Set("format", format)
			}
			u.RawQuery = q.Encode()
			src := u.String()
			if seen[src] {
				continue
			}
			seen[src] = true
			images = append(images, Image{URL: src, AltText: attr(img, "alt")})
		}
	}
	return images
}

func focalArticle(articles []*html.Node, statusID string) (focal *html.Node, before []*html.Node) {
	for i, a := range articles {
		quote := find(a, nil, isQuoteCard)
		link := find(a, quote, func(n *html.Node) bool {
			if !isElem(n, "a") {
				return false
			}
			_, id := linkStatus(attr(n, "href"))
			return id == statusID
		})
		if link == nil {
			continue
		}
		hasText := find(a, quote, func(n *html.Node) bool { return testID(n, "tweetText") }) != nil
		if hasText || len(postImages(a, quote)) > 0 {
			return a, articles[:i]
		}
	}
	return nil, nil
}

// isQuoteCard matches the embedded tweet X renders inside a status: a
// role="link" box carrying its own timestamp and text or media.
func isQuoteCard(n *html.Node) bool {
	if n.Type != html.ElementNode || attr(n, "role") != "link" {
		return false
	}
	hasTime := find(n, nil, func(c *html.Node) bool { return isElem(c, "time") }) != nil
	hasText := find(n, nil, func(c *html.Node) bool { return testID(c, "tweetText") }) != nil
	hasMedia := find(n, nil, isMedia) != nil
	return hasTime && (hasText || hasMedia)
}

func isMedia(n *html.Node) bool {
	return testID(n, "tweetPhoto") || testID(n, "videoPlayer")
}

func author(focal, quote *html.Node) (handle, name string) {
	block := find(focal, quote, func(n *html.Node) bool { return testID(n, "User-Name") })
	if block == nil {
		return "", ""
	}
	for _, a := range findAll(block, nil, func(n *html.Node) bool {
		if !isElem(n, "a") {
			return false
		}
		href := attr(n, "href")
		return strings.HasPrefix(href, "/") && !strings.Contains(href[1:], "/")
	}) {
		switch label := collapse(text(a, nil)); {
		case strings.HasPrefix(label, "@") && handle == "":
			handle = strings.TrimPrefix(label, "@")
		case label != "" && !strings.HasPrefix(label, "@") && name == "":
			name = label
		}
	}
	return handle, name
}

func postedAt(focal, quote *html.Node) string {
	t := find(focal, quote, func(n *html.Node) bool { return isElem(n, "time") && attr(n, "datetime") != "" })
	if t == nil {
		return ""
	}
	raw := attr(t, "datetime")
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return raw
	}
	return parsed.UTC().Format(time.RFC3339)
}

// replyTo reads the status this one answers off the nearest article rendered
// above the focal one; div[data-testid="reply-context"] names the handles but
// carries no id.
func replyTo(before []*html.Node, statusID string) string {
	for i := len(before) - 1; i >= 0; i-- {
		a := before[i]
		if find(a, nil, func(n *html.Node) bool { return testID(n, "tweetText") }) == nil {
			continue
		}
		if id := permalinkID(a); id != "" && id != statusID {
			return id
		}
	}
	return ""
}

func quotedStatusID(quote *html.Node) string {
	if quote == nil {
		return ""
	}
	if id := permalinkID(quote); id != "" {
		return id
	}
	link := find(quote, nil, func(n *html.Node) bool {
		if !isElem(n, "a") {
			return false
		}
		_, id := linkStatus(attr(n, "href"))
		return id != ""
	})
	if link == nil {
		return ""
	}
	_, id := linkStatus(attr(link, "href"))
	return id
}

// permalinkID reads the id off the anchor wrapping the timestamp, which is the
// one link guaranteed to point at the tweet itself rather than at media or a
// quoted status.
func permalinkID(root *html.Node) string {
	t := find(root, nil, func(n *html.Node) bool { return isElem(n, "time") })
	if t == nil {
		return ""
	}
	link := ancestorLink(t)
	if link == nil {
		return ""
	}
	_, id := linkStatus(attr(link, "href"))
	return id
}

func firstRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

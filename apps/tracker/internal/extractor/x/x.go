// Package x reads a status page on X (formerly Twitter) out of the rendered
// DOM the extension captures: X ships an empty shell to any plain fetch, so
// every selector here targets data-testid attributes rather than markup that
// only exists after hydration.
package x

import (
	"bytes"
	"context"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/andybalholm/cascadia"
	"golang.org/x/net/html"

	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
	"github.com/aquitano/aqt/apps/tracker/internal/extractor/dom"
)

const Name = "x"

func init() { extractor.Register(Extractor{}) }

type Extractor struct{}

type Image struct {
	URL     string `json:"url"`
	AltText string `json:"alt_text"`
}

type Post struct {
	StatusID     string `json:"status_id"`
	AuthorHandle string `json:"author_handle"`
	AuthorName   string `json:"author_name"`
	Text         string `json:"text"`
	PostedAt     string `json:"posted_at"`
}

type Data struct {
	Post
	PostURL         string  `json:"post_url"`
	Images          []Image `json:"images"`
	ReplyToStatusID string  `json:"reply_to_status_id,omitempty"`
	QuotedStatusID  string  `json:"quoted_status_id,omitempty"`
	MediaCount      int     `json:"media_count"`
	Lang            string  `json:"lang,omitempty"`
	Ancestors       []Post  `json:"ancestors"`
	Replies         []Post  `json:"replies"`
}

const titleRunes = 80

func (Extractor) Rule() extractor.Rule {
	return extractor.Rule{
		Extractor: Name,
		Version:   4,
		// Every subdomain, so X Pro's columns of notifications and messages
		// never fall through to the article fallback.
		Hosts:     []string{"x.com", "*.x.com", "twitter.com", "*.twitter.com"},
		PathRegex: `^/[^/]+/status/\d+`,
		Recapture: extractor.RecaptureAfterChange,
	}
}

var (
	tweet       = cascadia.MustCompile("[data-testid=tweet]:not([data-testid=tweet] *)")
	threadEntry = cascadia.MustCompile("[data-testid=tweet]:not([data-testid=tweet] *, h2 *), h2:not([data-testid=tweet] *, h2 *)")
	// quoteCard is the embedded tweet X renders inside a status: a
	// role="link" box carrying its own timestamp and text or media.
	quoteCard = cascadia.MustCompile("[role=link]:has(time):has([data-testid=tweetText], [data-testid=tweetPhoto], [data-testid=videoPlayer])")
	tweetText = cascadia.MustCompile("[data-testid=tweetText]")
	// A media container nested inside another one is counted once.
	media       = cascadia.MustCompile("[data-testid=tweetPhoto]:not([data-testid=tweetPhoto] *, [data-testid=videoPlayer] *), [data-testid=videoPlayer]:not([data-testid=tweetPhoto] *, [data-testid=videoPlayer] *)")
	photo       = cascadia.MustCompile("[data-testid=tweetPhoto]:not([data-testid=tweetPhoto] *)")
	imgTag      = cascadia.MustCompile("img")
	link        = cascadia.MustCompile("a")
	userName    = cascadia.MustCompile("[data-testid=User-Name]")
	profileLink = cascadia.MustCompile("a[href#=(^/[^/]*$)]")
	timestamp   = cascadia.MustCompile("time")
	datedTime   = cascadia.MustCompile(`time[datetime]:not([datetime=""])`)
)

func (Extractor) Extract(_ context.Context, raw []byte, pageURL *url.URL) (extractor.Record, error) {
	_, statusID := linkStatus(pageURL.Path)
	if statusID == "" {
		return extractor.Record{}, extractor.ErrNoMatch
	}
	doc, err := html.Parse(bytes.NewReader(raw))
	if err != nil {
		return extractor.Record{}, err
	}

	articles := tweet.MatchAll(doc)
	i := focalIndex(articles, statusID)
	if i < 0 {
		return extractor.Record{}, extractor.ErrNoMatch
	}
	focal := articles[i]

	quote := quoteCard.MatchFirst(focal)
	body := outside(tweetText, quote).MatchFirst(focal)
	images := postImages(focal, quote)
	if body == nil && len(images) == 0 {
		return extractor.Record{}, extractor.ErrNoMatch
	}

	post := readPost(focal)
	post.StatusID = statusID
	if post.AuthorHandle == "" {
		post.AuthorHandle, _ = linkStatus(pageURL.Path)
	}
	postURL := "https://x.com/" + post.AuthorHandle + "/status/" + statusID
	data := Data{
		Post:           post,
		PostURL:        postURL,
		Images:         images,
		QuotedStatusID: quotedStatusID(quote),
		MediaCount:     len(outside(media, quote).MatchAll(focal)),
		Lang:           dom.Attr(body, "lang"),
		Ancestors:      conversation(articles[:i], statusID),
		Replies:        conversation(repliesBelow(doc, focal), statusID),
	}
	// div[data-testid="reply-context"] names the handles answered but carries
	// no id, so the parent is the nearest post rendered above.
	if n := len(data.Ancestors); n > 0 {
		data.ReplyToStatusID = data.Ancestors[n-1].StatusID
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
	for _, p := range slices.Concat(data.Ancestors, data.Replies) {
		search = append(search, p.AuthorHandle, p.AuthorName, p.Text)
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
	for _, p := range outside(photo, quote).MatchAll(focal) {
		for _, img := range imgTag.MatchAll(p) {
			u, err := url.Parse(dom.Attr(img, "src"))
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
			images = append(images, Image{URL: src, AltText: dom.Attr(img, "alt")})
		}
	}
	return images
}

func focalIndex(articles []*html.Node, statusID string) int {
	for i, a := range articles {
		quote := quoteCard.MatchFirst(a)
		linked := slices.ContainsFunc(outside(link, quote).MatchAll(a), func(n *html.Node) bool {
			_, id := linkStatus(dom.Attr(n, "href"))
			return id == statusID
		})
		if !linked {
			continue
		}
		if outside(tweetText, quote).MatchFirst(a) != nil || len(postImages(a, quote)) > 0 {
			return i
		}
	}
	return -1
}

func readPost(a *html.Node) Post {
	quote := quoteCard.MatchFirst(a)
	handle, name := author(a, quote)
	return Post{
		StatusID:     permalinkID(a, quote),
		AuthorHandle: handle,
		AuthorName:   name,
		Text:         text(outside(tweetText, quote).MatchFirst(a)),
		PostedAt:     postedAt(a, quote),
	}
}

// repliesBelow is every post after the focal one up to the next section
// heading: below the replies, X adds a "Discover more" section of posts from
// strangers, which would otherwise be indexed as this thread's.
func repliesBelow(doc, focal *html.Node) []*html.Node {
	var replies []*html.Node
	below := false
	for _, n := range threadEntry.MatchAll(doc) {
		switch {
		case n == focal:
			below = true
		case !below:
		case n.Data == "h2":
			return replies
		default:
			replies = append(replies, n)
		}
	}
	return replies
}

// conversation reads the posts X renders around the focal one: the thread it
// answers above it, the replies below.
func conversation(articles []*html.Node, statusID string) []Post {
	posts := []Post{}
	for _, a := range articles {
		if p := readPost(a); p.StatusID != "" && p.StatusID != statusID {
			posts = append(posts, p)
		}
	}
	return posts
}

func author(focal, quote *html.Node) (handle, name string) {
	block := outside(userName, quote).MatchFirst(focal)
	if block == nil {
		return "", ""
	}
	for _, a := range profileLink.MatchAll(block) {
		switch label := collapse(text(a)); {
		case strings.HasPrefix(label, "@") && handle == "":
			handle = strings.TrimPrefix(label, "@")
		case label != "" && !strings.HasPrefix(label, "@") && name == "":
			name = label
		}
	}
	return handle, name
}

func postedAt(focal, quote *html.Node) string {
	t := outside(datedTime, quote).MatchFirst(focal)
	if t == nil {
		return ""
	}
	raw := dom.Attr(t, "datetime")
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return raw
	}
	return parsed.UTC().Format(time.RFC3339)
}

func quotedStatusID(quote *html.Node) string {
	if quote == nil {
		return ""
	}
	if id := permalinkID(quote, nil); id != "" {
		return id
	}
	for _, a := range link.MatchAll(quote) {
		if _, id := linkStatus(dom.Attr(a, "href")); id != "" {
			return id
		}
	}
	return ""
}

// permalinkID reads the id off the anchor wrapping the timestamp, which is the
// one link guaranteed to point at the tweet itself rather than at media or a
// quoted status.
func permalinkID(root, skip *html.Node) string {
	t := outside(timestamp, skip).MatchFirst(root)
	if t == nil {
		return ""
	}
	for p := t.Parent; p != nil; p = p.Parent {
		if link.Match(p) {
			_, id := linkStatus(dom.Attr(p, "href"))
			return id
		}
	}
	return ""
}

func firstRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

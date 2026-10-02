// Package reddit reads a Reddit thread, the post and the comments the page
// shows, from www.reddit.com (shreddit web components) and old.reddit.com.
package reddit

import (
	"bytes"
	"context"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/andybalholm/cascadia"
	"golang.org/x/net/html"

	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
	"github.com/aquitano/aqt/apps/tracker/internal/extractor/dom"
)

const Name = "reddit"

type Data struct {
	ID        string    `json:"id"`
	Subreddit string    `json:"subreddit"`
	Title     string    `json:"title"`
	URL       string    `json:"url,omitempty"`
	Author    string    `json:"author"`
	Score     int       `json:"score"`
	CreatedAt string    `json:"created_at"`
	Body      string    `json:"body,omitempty"`
	Comments  []Comment `json:"comments"`
}

type Comment struct {
	ID        string `json:"id"`
	Author    string `json:"author"`
	Body      string `json:"body"`
	Score     int    `json:"score"`
	CreatedAt string `json:"created_at"`
	Depth     int    `json:"depth"`
}

type Extractor struct{}

func init() { extractor.Register(Extractor{}) }

func (Extractor) Rule() extractor.Rule {
	return extractor.Rule{
		Extractor: Name,
		Version:   1,
		Hosts:     []string{"www.reddit.com", "old.reddit.com"},
		PathRegex: `^/r/[^/]+/comments/[a-z0-9]+(/|$)`,
		Recapture: extractor.RecaptureAfterChange,
	}
}

var threadPath = regexp.MustCompile(`^/r/([^/]+)/comments/([a-z0-9]+)(/|$)`)

func (Extractor) Extract(_ context.Context, raw []byte, pageURL *url.URL) (extractor.Record, error) {
	m := threadPath.FindStringSubmatch(pageURL.Path)
	if m == nil {
		return extractor.Record{}, extractor.ErrNoMatch
	}
	doc, err := html.Parse(bytes.NewReader(raw))
	if err != nil {
		return extractor.Record{}, err
	}
	data, err := thread(doc, "t3_"+m[2])
	if err != nil {
		return extractor.Record{}, err
	}
	if data.Subreddit == "" {
		data.Subreddit = m[1]
	}

	search := []string{data.Title, data.URL, data.Author, data.Body}
	for _, c := range data.Comments {
		search = append(search, c.Author, c.Body)
	}
	return extractor.Record{
		CanonicalURL: "https://www.reddit.com/r/" + data.Subreddit + "/comments/" + data.ID + "/",
		Title:        data.Title,
		SearchText:   strings.TrimSpace(strings.Join(search, "\n")),
		Data:         data,
	}, nil
}

var (
	shredditPost     = cascadia.MustCompile("shreddit-post")
	shredditTextBody = cascadia.MustCompile("[slot=text-body]")
	shredditComment  = cascadia.MustCompile("shreddit-comment")
	shredditBody     = cascadia.MustCompile("[slot=comment]")
	oldPost          = cascadia.MustCompile(".thing.link")
	oldComment       = cascadia.MustCompile(".thing.comment")
	oldLiveComment   = cascadia.MustCompile(".thing.comment:not(.deleted)")
)

// thread reads whichever of the two front ends rendered the page, from the
// post carrying the URL's id: any other is a page the tab showed before.
func thread(doc *html.Node, fullname string) (Data, error) {
	posts := append(shredditPost.MatchAll(doc), oldPost.MatchAll(doc)...)
	for _, post := range posts {
		switch {
		case dom.Attr(post, "id") == fullname:
			return shredditThread(doc, post, fullname), nil
		case dom.Attr(post, "data-fullname") == fullname:
			return oldThread(doc, post), nil
		}
	}
	if len(posts) > 0 {
		return Data{}, extractor.ErrStale
	}
	return Data{}, extractor.ErrNoMatch
}

func shredditThread(doc, post *html.Node, fullname string) Data {
	d := Data{
		ID:        strings.TrimPrefix(fullname, "t3_"),
		Subreddit: dom.Attr(post, "subreddit-name"),
		Title:     dom.Attr(post, "post-title"),
		URL:       linkURL(dom.Attr(post, "domain"), dom.Attr(post, "content-href")),
		Author:    dom.Attr(post, "author"),
		Score:     atoi(dom.Attr(post, "score")),
		CreatedAt: utc(shredditTime, dom.Attr(post, "created-timestamp")),
		Body:      dom.Text(shredditTextBody.MatchFirst(post)),
		Comments:  []Comment{},
	}
	// Replies nest inside their parent, so a body belongs to the nearest
	// comment enclosing it.
	for _, body := range shredditBody.MatchAll(doc) {
		c := closest(body, shredditComment)
		if c == nil || dom.Attr(c, "postid") != fullname {
			continue
		}
		d.Comments = append(d.Comments, Comment{
			ID:        strings.TrimPrefix(dom.Attr(c, "thingid"), "t1_"),
			Author:    dom.Attr(c, "author"),
			Body:      dom.Text(body),
			Score:     atoi(dom.Attr(c, "score")),
			CreatedAt: utc(shredditTime, dom.Attr(c, "created")),
			Depth:     atoi(dom.Attr(c, "depth")),
		})
	}
	return d
}

var (
	oldTitle = cascadia.MustCompile("a.title")
	oldBody  = cascadia.MustCompile(".usertext-body .md")
	oldEntry = cascadia.MustCompile(".entry")
	oldScore = cascadia.MustCompile(".tagline .score.unvoted")
	oldTime  = cascadia.MustCompile(".tagline time.live-timestamp")
)

func oldThread(doc, post *html.Node) Data {
	d := Data{
		ID:        strings.TrimPrefix(dom.Attr(post, "data-fullname"), "t3_"),
		Subreddit: dom.Attr(post, "data-subreddit"),
		Title:     dom.Text(oldTitle.MatchFirst(post)),
		URL:       linkURL(dom.Attr(post, "data-domain"), dom.Attr(post, "data-url")),
		Author:    dom.Attr(post, "data-author"),
		Score:     atoi(dom.Attr(post, "data-score")),
		Body:      dom.Text(oldBody.MatchFirst(post)),
		Comments:  []Comment{},
	}
	if ms, err := strconv.ParseInt(dom.Attr(post, "data-timestamp"), 10, 64); err == nil {
		d.CreatedAt = time.UnixMilli(ms).UTC().Format(time.RFC3339)
	}
	for _, c := range oldLiveComment.MatchAll(doc) {
		// The comment's own entry, since its replies nest inside it.
		entry := child(c, oldEntry)
		if entry == nil {
			continue
		}
		author := dom.Attr(c, "data-author")
		if author == "" {
			author = "[deleted]"
		}
		d.Comments = append(d.Comments, Comment{
			ID:        strings.TrimPrefix(dom.Attr(c, "data-fullname"), "t1_"),
			Author:    author,
			Body:      dom.Text(oldBody.MatchFirst(entry)),
			Score:     atoi(dom.Attr(oldScore.MatchFirst(entry), "title")),
			CreatedAt: utc(time.RFC3339, dom.Attr(oldTime.MatchFirst(entry), "datetime")),
			Depth:     oldDepth(c),
		})
	}
	return d
}

// linkURL is where a link post points; a self post links to itself.
func linkURL(domain, href string) string {
	if strings.HasPrefix(domain, "self.") {
		return ""
	}
	return href
}

func closest(n *html.Node, sel cascadia.Selector) *html.Node {
	for p := n.Parent; p != nil; p = p.Parent {
		if p.Type == html.ElementNode && sel.Match(p) {
			return p
		}
	}
	return nil
}

func child(n *html.Node, sel cascadia.Selector) *html.Node {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode && sel.Match(c) {
			return c
		}
	}
	return nil
}

func oldDepth(comment *html.Node) int {
	depth := 0
	for p := comment.Parent; p != nil; p = p.Parent {
		if p.Type == html.ElementNode && oldComment.Match(p) {
			depth++
		}
	}
	return depth
}

const shredditTime = "2006-01-02T15:04:05.999999-0700"

func utc(layout, s string) string {
	t, err := time.Parse(layout, s)
	if err != nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

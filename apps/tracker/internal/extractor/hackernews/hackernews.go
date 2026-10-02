// Package hackernews reads a Hacker News story page: the story and every
// comment under it, which HN renders on the server.
package hackernews

import (
	"bytes"
	"context"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/andybalholm/cascadia"
	"golang.org/x/net/html"

	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
	"github.com/aquitano/aqt/apps/tracker/internal/extractor/dom"
)

const Name = "hackernews"

type Data struct {
	ID        int       `json:"id"`
	Title     string    `json:"title"`
	URL       string    `json:"url,omitempty"`
	Author    string    `json:"author"`
	Points    int       `json:"points"`
	CreatedAt string    `json:"created_at"`
	Body      string    `json:"body,omitempty"`
	Comments  []Comment `json:"comments"`
}

type Comment struct {
	ID        int    `json:"id"`
	Author    string `json:"author"`
	Body      string `json:"body"`
	CreatedAt string `json:"created_at"`
	Depth     int    `json:"depth"`
}

type Extractor struct{}

func init() { extractor.Register(Extractor{}) }

func (Extractor) Rule() extractor.Rule {
	return extractor.Rule{
		Extractor: Name,
		Version:   1,
		Hosts:     []string{"news.ycombinator.com"},
		PathRegex: `^/item$`,
		QueryKeys: []string{"id"},
		Recapture: extractor.RecaptureAfterChange,
	}
}

var (
	story      = cascadia.MustCompile("table.fatitem")
	storyRow   = cascadia.MustCompile("tr.athing.submission")
	titleLink  = cascadia.MustCompile(".titleline > a")
	score      = cascadia.MustCompile(".score")
	user       = cascadia.MustCompile(".hnuser")
	age        = cascadia.MustCompile(".age")
	topText    = cascadia.MustCompile(".toptext")
	commentRow = cascadia.MustCompile("tr.athing.comtr")
	indent     = cascadia.MustCompile("td.ind")
	commText   = cascadia.MustCompile(".commtext")
)

func (Extractor) Extract(_ context.Context, raw []byte, pageURL *url.URL) (extractor.Record, error) {
	id, err := strconv.Atoi(pageURL.Query().Get("id"))
	if err != nil {
		return extractor.Record{}, extractor.ErrNoMatch
	}
	doc, err := html.Parse(bytes.NewReader(raw))
	if err != nil {
		return extractor.Record{}, err
	}
	fatitem := story.MatchFirst(doc)
	if fatitem == nil {
		return extractor.Record{}, extractor.ErrNoMatch
	}
	switch row := storyRow.MatchFirst(fatitem); {
	case row == nil:
		// A comment's own page: its fatitem holds the comment, not a story.
		return extractor.Record{}, extractor.ErrNoMatch
	case dom.Attr(row, "id") != strconv.Itoa(id):
		return extractor.Record{}, extractor.ErrStale
	}

	canonical := "https://news.ycombinator.com/item?id=" + strconv.Itoa(id)
	link := titleLink.MatchFirst(fatitem)
	data := Data{
		ID:        id,
		Title:     dom.Text(link),
		URL:       storyURL(pageURL, dom.Attr(link, "href"), canonical),
		Author:    dom.Text(user.MatchFirst(fatitem)),
		Points:    points(score.MatchFirst(fatitem)),
		CreatedAt: createdAt(age.MatchFirst(fatitem)),
		Body:      dom.Text(topText.MatchFirst(fatitem)),
		Comments:  comments(doc),
	}
	if data.Title == "" {
		return extractor.Record{}, extractor.ErrNoMatch
	}

	search := []string{data.Title, data.URL, data.Author, data.Body}
	for _, c := range data.Comments {
		search = append(search, c.Author, c.Body)
	}
	return extractor.Record{
		CanonicalURL: canonical,
		Title:        data.Title,
		SearchText:   strings.TrimSpace(strings.Join(search, "\n")),
		Data:         data,
	}, nil
}

// storyURL is the link a story points at, empty for an Ask HN post whose
// title links back to the item itself.
func storyURL(pageURL *url.URL, href, canonical string) string {
	u, err := pageURL.Parse(href)
	if err != nil || href == "" || u.String() == canonical {
		return ""
	}
	return u.String()
}

// comments skips a deleted comment, which keeps its row and its replies but
// has no author or text.
func comments(doc *html.Node) []Comment {
	out := []Comment{}
	for _, row := range commentRow.MatchAll(doc) {
		body := commText.MatchFirst(row)
		if body == nil {
			continue
		}
		id, _ := strconv.Atoi(dom.Attr(row, "id"))
		depth, _ := strconv.Atoi(dom.Attr(indent.MatchFirst(row), "indent"))
		out = append(out, Comment{
			ID:        id,
			Author:    dom.Text(user.MatchFirst(row)),
			Body:      dom.Text(body),
			CreatedAt: createdAt(age.MatchFirst(row)),
			Depth:     depth,
		})
	}
	return out
}

// createdAt reads the UTC timestamp HN puts in an age span's title, which
// may carry the Unix time after it.
func createdAt(n *html.Node) string {
	stamp, _, _ := strings.Cut(dom.Attr(n, "title"), " ")
	t, err := time.Parse("2006-01-02T15:04:05", stamp)
	if err != nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

func points(n *html.Node) int {
	count, _, _ := strings.Cut(dom.Text(n), " ")
	p, _ := strconv.Atoi(count)
	return p
}

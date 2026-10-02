// Package article is the fallback extractor: it matches every host and
// keeps whatever readable prose readability finds on the page.
package article

import (
	"bytes"
	"context"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	readability "codeberg.org/readeck/go-readability/v2"
	"golang.org/x/net/html"

	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
)

const Name = "article"

// A page whose readable text is shorter than this is a nav bar, a cookie
// banner or a login wall, not something that was read.
const minTextLength = 200

type Data struct {
	Title     string `json:"title"`
	Byline    string `json:"byline"`
	SiteName  string `json:"site_name"`
	Excerpt   string `json:"excerpt"`
	Published string `json:"published"`
	Language  string `json:"language"`
	Text      string `json:"text"`
	WordCount int    `json:"word_count"`
}

type Extractor struct{}

func init() { extractor.Register(Extractor{}) }

// Rule dwells far longer than a site extractor: thirty seconds on a page is
// the signal that it was read rather than bounced off.
func (Extractor) Rule() extractor.Rule {
	return extractor.Rule{
		Extractor: Name,
		Version:   2,
		Hosts:     []string{"*"},
		DwellMS:   30000,
	}
}

func (Extractor) Extract(_ context.Context, raw []byte, pageURL *url.URL) (extractor.Record, error) {
	art, err := readability.FromReader(bytes.NewReader(raw), pageURL)
	if err != nil {
		return extractor.Record{}, err
	}
	if art.Node == nil {
		return extractor.Record{}, extractor.ErrNoMatch
	}
	var rendered strings.Builder
	if err := art.RenderText(&rendered); err != nil {
		return extractor.Record{}, err
	}
	text := normalizeWhitespace(rendered.String())
	if utf8.RuneCountInString(text) < minTextLength {
		return extractor.Record{}, extractor.ErrNoMatch
	}
	doc, err := html.Parse(bytes.NewReader(raw))
	if err != nil {
		return extractor.Record{}, err
	}

	data := Data{
		Title:     strings.TrimSpace(art.Title()),
		Byline:    strings.TrimSpace(art.Byline()),
		SiteName:  strings.TrimSpace(art.SiteName()),
		Excerpt:   strings.TrimSpace(art.Excerpt()),
		Published: publishedDate(art),
		Language:  strings.TrimSpace(art.Language()),
		Text:      text,
		WordCount: len(strings.Fields(text)),
	}
	if data.Title == "" {
		data.Title = documentTitle(doc)
	}
	return extractor.Record{
		CanonicalURL: canonicalURL(doc, pageURL),
		Title:        data.Title,
		SearchText: strings.TrimSpace(strings.Join(
			[]string{data.Title, data.Byline, data.SiteName, data.Text}, "\n")),
		Data: data,
	}, nil
}

func publishedDate(art readability.Article) string {
	published, err := art.PublishedTime()
	if err != nil {
		return ""
	}
	return published.Format(time.DateOnly)
}

var (
	horizontalSpace = regexp.MustCompile(`[ \t]+`)
	spacedNewline   = regexp.MustCompile(` ?\n ?`)
	blankLines      = regexp.MustCompile(`\n{3,}`)
)

func normalizeWhitespace(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = horizontalSpace.ReplaceAllString(s, " ")
	s = spacedNewline.ReplaceAllString(s, "\n")
	s = blankLines.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}

// canonicalURL trusts <link rel=canonical> only when it names an article on
// the page's own site. Records are keyed on it, and some sites point every
// article's canonical at their homepage, which would merge them all into one.
func canonicalURL(doc *html.Node, pageURL *url.URL) string {
	link := findNode(doc, func(n *html.Node) bool {
		return n.Data == "link" && strings.EqualFold(attr(n, "rel"), "canonical")
	})
	if link != nil {
		u, err := url.Parse(strings.TrimSpace(attr(link, "href")))
		if err == nil && u.IsAbs() && siteHost(u) == siteHost(pageURL) && u.Path != "" && u.Path != "/" {
			return u.String()
		}
	}
	return pageURL.String()
}

func siteHost(u *url.URL) string {
	return strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
}

func documentTitle(doc *html.Node) string {
	title := findNode(doc, func(n *html.Node) bool { return n.Data == "title" })
	if title == nil || title.FirstChild == nil {
		return ""
	}
	return strings.TrimSpace(title.FirstChild.Data)
}

func findNode(n *html.Node, pred func(*html.Node) bool) *html.Node {
	if n.Type == html.ElementNode && pred(n) {
		return n
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if found := findNode(c, pred); found != nil {
			return found
		}
	}
	return nil
}

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

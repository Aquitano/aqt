// Package stackexchange reads a question page on Stack Overflow and the other
// Stack Exchange sites: the question, its answers, and the comments the page
// shows under each.
package stackexchange

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

const Name = "stackexchange"

type Data struct {
	Post
	Title   string   `json:"title"`
	Tags    []string `json:"tags"`
	Answers []Answer `json:"answers"`
}

type Answer struct {
	Post
	Accepted bool `json:"accepted"`
}

type Post struct {
	ID        int       `json:"id"`
	Author    string    `json:"author"`
	Score     int       `json:"score"`
	CreatedAt string    `json:"created_at"`
	Body      string    `json:"body"`
	Comments  []Comment `json:"comments"`
}

type Comment struct {
	Author    string `json:"author"`
	Body      string `json:"body"`
	Score     int    `json:"score"`
	CreatedAt string `json:"created_at"`
}

type Extractor struct{}

func init() { extractor.Register(Extractor{}) }

func (Extractor) Rule() extractor.Rule {
	return extractor.Rule{
		Extractor: Name,
		Version:   1,
		Hosts:     []string{"stackoverflow.com", "superuser.com", "serverfault.com", "askubuntu.com", "*.stackexchange.com"},
		PathRegex: `^/questions/\d+(/|$)`,
		Recapture: extractor.RecaptureAfterChange,
	}
}

var questionPath = regexp.MustCompile(`^/questions/(\d+)(/|$)`)

var (
	question    = cascadia.MustCompile("#question")
	title       = cascadia.MustCompile("#question-header h1")
	tag         = cascadia.MustCompile(".post-taglist .post-tag")
	answer      = cascadia.MustCompile("#answers .answer")
	accepted    = cascadia.MustCompile(".accepted-answer")
	postBody    = cascadia.MustCompile(".js-post-body")
	dateCreated = cascadia.MustCompile("time[itemprop=dateCreated]")
	comment     = cascadia.MustCompile("li[data-comment-id]")
	commentText = cascadia.MustCompile(".comment-copy")
	commentUser = cascadia.MustCompile(".comment-user")
	commentDate = cascadia.MustCompile(".comment-date [title]")
)

func (Extractor) Extract(_ context.Context, raw []byte, pageURL *url.URL) (extractor.Record, error) {
	m := questionPath.FindStringSubmatch(pageURL.Path)
	if m == nil {
		return extractor.Record{}, extractor.ErrNoMatch
	}
	doc, err := html.Parse(bytes.NewReader(raw))
	if err != nil {
		return extractor.Record{}, err
	}
	q := question.MatchFirst(doc)
	switch {
	case q == nil:
		return extractor.Record{}, extractor.ErrNoMatch
	case dom.Attr(q, "data-questionid") != m[1]:
		return extractor.Record{}, extractor.ErrStale
	}

	data := Data{Post: post(q), Title: dom.Text(title.MatchFirst(doc)), Tags: []string{}, Answers: []Answer{}}
	if data.Title == "" {
		return extractor.Record{}, extractor.ErrNoMatch
	}
	data.ID, _ = strconv.Atoi(m[1])
	// The question's own timestamp sits in the page header, above its post.
	data.CreatedAt = createdAt(dom.Attr(dateCreated.MatchFirst(doc), "datetime"))
	for _, t := range tag.MatchAll(q) {
		data.Tags = append(data.Tags, dom.Text(t))
	}
	for _, a := range answer.MatchAll(doc) {
		p := post(a)
		p.ID, _ = strconv.Atoi(dom.Attr(a, "data-answerid"))
		p.CreatedAt = createdAt(dom.Attr(dateCreated.MatchFirst(a), "datetime"))
		data.Answers = append(data.Answers, Answer{Post: p, Accepted: accepted.Match(a)})
	}

	search := append([]string{data.Title, strings.Join(data.Tags, " ")}, data.searchText()...)
	for _, a := range data.Answers {
		search = append(search, a.searchText()...)
	}
	canonical := &url.URL{Scheme: "https", Host: strings.ToLower(pageURL.Hostname()), Path: "/questions/" + m[1]}
	return extractor.Record{
		CanonicalURL: canonical.String(),
		Title:        data.Title,
		SearchText:   strings.TrimSpace(strings.Join(search, "\n")),
		Data:         data,
	}, nil
}

func post(n *html.Node) Post {
	p := Post{
		Author:   dom.Attr(n, "data-author-username"),
		Body:     dom.Text(postBody.MatchFirst(n)),
		Comments: []Comment{},
	}
	p.Score, _ = strconv.Atoi(dom.Attr(n, "data-score"))
	for _, c := range comment.MatchAll(n) {
		score, _ := strconv.Atoi(dom.Attr(c, "data-comment-score"))
		// The title reads "2024-11-08 11:09:41Z, License: CC BY-SA 4.0".
		stamp, _, _ := strings.Cut(dom.Attr(commentDate.MatchFirst(c), "title"), ",")
		p.Comments = append(p.Comments, Comment{
			Author:    dom.Text(commentUser.MatchFirst(c)),
			Body:      dom.Text(commentText.MatchFirst(c)),
			Score:     score,
			CreatedAt: createdAt(stamp),
		})
	}
	return p
}

func (p Post) searchText() []string {
	words := []string{p.Author, p.Body}
	for _, c := range p.Comments {
		words = append(words, c.Author, c.Body)
	}
	return words
}

func createdAt(stamp string) string {
	t, err := time.Parse("2006-01-02 15:04:05Z", stamp)
	if err != nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

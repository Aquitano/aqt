// Package github extracts repository roots, issues, pull requests and
// discussions from github.com pages.
package github

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"fmt"
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

const Name = "github"

const (
	KindRepo       = "repo"
	KindIssue      = "issue"
	KindPull       = "pull"
	KindDiscussion = "discussion"
)

type Data struct {
	Kind      string    `json:"kind"`
	Owner     string    `json:"owner"`
	Repo      string    `json:"repo"`
	Number    int       `json:"number"`
	Title     string    `json:"title"`
	State     string    `json:"state"`
	Author    string    `json:"author"`
	Body      string    `json:"body"`
	Labels    []string  `json:"labels"`
	Category  string    `json:"category,omitempty"`
	Score     int       `json:"score,omitempty"`
	CreatedAt string    `json:"created_at"`
	Comments  []Comment `json:"comments"`
}

// Score, Answer and Replies are a discussion comment's upvotes, whether it
// was marked as the answer, and the replies threaded under it.
type Comment struct {
	Author    string    `json:"author"`
	Body      string    `json:"body"`
	CreatedAt string    `json:"created_at"`
	Score     int       `json:"score,omitempty"`
	Answer    bool      `json:"answer,omitempty"`
	Replies   []Comment `json:"replies,omitempty"`
}

type Extractor struct{}

func init() { extractor.Register(Extractor{}) }

func (Extractor) Rule() extractor.Rule {
	return extractor.Rule{
		Extractor: Name,
		Version:   5,
		Hosts:     []string{"github.com"},
		PathRegex: `^/[^/]+/[^/]+(/(issues|pull|discussions)/\d+)?/?$`,
		// GitHub's own two-segment pages look like owner/repo. Some are
		// secret: /settings/tokens shows a new token in the page.
		ExcludePathRegex: `^/(settings|login|logout|sessions|session|signup|join|password_reset|account|auth|notifications|issues|pulls|orgs|organizations|new|marketplace|sponsors|apps|codespaces|copilot|github-copilot|dashboard|explore|topics|trending|collections|search|stars|users|enterprises|features|security)(/|$)`,
		Recapture:        extractor.RecaptureAfterChange,
	}
}

func (Extractor) Extract(_ context.Context, raw []byte, pageURL *url.URL) (extractor.Record, error) {
	target, ok := parsePath(pageURL.Path)
	if !ok {
		return extractor.Record{}, extractor.ErrNoMatch
	}
	doc, err := html.Parse(bytes.NewReader(raw))
	if err != nil {
		return extractor.Record{}, err
	}
	emb := embeddedData(doc)

	var data Data
	switch target.kind {
	case KindIssue:
		data, ok = issueData(target, emb, doc)
	case KindPull:
		data, ok = pullData(target, emb, doc)
	case KindDiscussion:
		data, ok = discussionData(target, doc)
	default:
		data, ok = repoData(target, emb, doc)
	}
	if !ok {
		return extractor.Record{}, extractor.ErrNoMatch
	}
	// GitHub navigates in place and leaves the previous page's embedded data
	// in the DOM, so the data has to describe the page the URL names.
	if !strings.EqualFold(data.Owner, target.owner) || !strings.EqualFold(data.Repo, target.repo) || data.Number != target.number {
		return extractor.Record{}, extractor.ErrStale
	}

	title := data.Owner + "/" + data.Repo
	path := "/" + data.Owner + "/" + data.Repo
	if data.Kind != KindRepo {
		title = fmt.Sprintf("%s#%d %s", title, data.Number, data.Title)
		path = fmt.Sprintf("%s/%s/%d", path, pathSegment(data.Kind), data.Number)
	}
	canonical := &url.URL{Scheme: pageURL.Scheme, Host: pageURL.Host, Path: path}
	search := []string{data.Title, data.Body, strings.Join(data.Labels, " "), data.Category}
	for _, c := range data.Comments {
		search = append(search, c.Body)
		for _, r := range c.Replies {
			search = append(search, r.Body)
		}
	}
	return extractor.Record{
		CanonicalURL: canonical.String(),
		Title:        title,
		SearchText:   strings.TrimSpace(strings.Join(search, "\n")),
		Data:         data,
	}, nil
}

func pathSegment(kind string) string {
	switch kind {
	case KindPull:
		return "pull"
	case KindDiscussion:
		return "discussions"
	}
	return "issues"
}

var pathRe = regexp.MustCompile(`^/([^/]+)/([^/]+)(?:/(issues|pull|discussions)/(\d+))?/?$`)

type target struct {
	kind   string
	owner  string
	repo   string
	number int
}

func parsePath(p string) (target, bool) {
	m := pathRe.FindStringSubmatch(strings.TrimSuffix(p, "/"))
	if m == nil {
		return target{}, false
	}
	t := target{kind: KindRepo, owner: m[1], repo: m[2]}
	switch m[3] {
	case "issues":
		t.kind = KindIssue
	case "pull":
		t.kind = KindPull
	case "discussions":
		t.kind = KindDiscussion
	}
	if m[4] != "" {
		n, err := strconv.Atoi(m[4])
		if err != nil {
			return target{}, false
		}
		t.number = n
	}
	return t, true
}

// embedded is the slice of GitHub's react-app.embeddedData payload this
// extractor reads: the issue GraphQL preload, the pull request route data
// and the repository sidebar.
type embedded struct {
	Payload struct {
		PreloadedQueries []struct {
			Result struct {
				Data struct {
					Repository struct {
						Issue *issueNode `json:"issue"`
					} `json:"repository"`
				} `json:"data"`
			} `json:"result"`
		} `json:"preloadedQueries"`
		PullRequestsLayoutRoute struct {
			PullRequest *pullNode `json:"pullRequest"`
			Repository  struct {
				Name       string `json:"name"`
				OwnerLogin string `json:"ownerLogin"`
			} `json:"repository"`
		} `json:"pullRequestsLayoutRoute"`
		SidebarAbout *struct {
			Description string `json:"description"`
			OwnerLogin  string `json:"ownerLogin"`
			RepoName    string `json:"repoName"`
			Topics      []struct {
				Name string `json:"name"`
			} `json:"topics"`
		} `json:"sidebarAbout"`
	} `json:"payload"`
}

type issueNode struct {
	Number     int    `json:"number"`
	Title      string `json:"title"`
	Body       string `json:"body"`
	State      string `json:"state"`
	CreatedAt  string `json:"createdAt"`
	Author     login  `json:"author"`
	Repository struct {
		Name  string `json:"name"`
		Owner login  `json:"owner"`
	} `json:"repository"`
	Labels struct {
		Edges []struct {
			Node struct {
				Name string `json:"name"`
			} `json:"node"`
		} `json:"edges"`
	} `json:"labels"`
}

type pullNode struct {
	Number      int    `json:"number"`
	Title       string `json:"title"`
	State       string `json:"state"`
	CreatedTime string `json:"createdTime"`
	Author      login  `json:"author"`
}

type login struct {
	Login string `json:"login"`
}

var (
	embeddedScript = cascadia.MustCompile(`script[data-target="react-app.embeddedData"]`)
	issueTitle     = cascadia.MustCompile("[data-testid=issue-title]")
	issueAuthor    = cascadia.MustCompile("[data-testid=issue-body-header-author]")
	stateLabel     = cascadia.MustCompile("[data-component=StateLabel]")
	jsIssueTitle   = cascadia.MustCompile(".js-issue-title")
	markdownTitle  = cascadia.MustCompile(".markdown-title")
	author         = cascadia.MustCompile(".author")
	itemName       = cascadia.MustCompile("[itemprop=name]")
	itemAuthor     = cascadia.MustCompile("[itemprop=author]")
	readmeArticle  = cascadia.MustCompile("article.markdown-body")
	markdown       = cascadia.MustCompile(".markdown-body")
)

func embeddedData(doc *html.Node) *embedded {
	script := embeddedScript.MatchFirst(doc)
	if script == nil || script.FirstChild == nil {
		return nil
	}
	var e embedded
	if err := json.Unmarshal([]byte(script.FirstChild.Data), &e); err != nil {
		return nil
	}
	return &e
}

func (e *embedded) issue() *issueNode {
	if e == nil {
		return nil
	}
	for _, q := range e.Payload.PreloadedQueries {
		if issue := q.Result.Data.Repository.Issue; issue != nil {
			return issue
		}
	}
	return nil
}

func issueData(t target, emb *embedded, doc *html.Node) (Data, bool) {
	d := Data{Kind: KindIssue, Owner: t.owner, Repo: t.repo, Number: t.number, Labels: []string{}, Comments: comments(doc)}
	if issue := emb.issue(); issue != nil {
		if issue.Repository.Owner.Login != "" {
			d.Owner, d.Repo = issue.Repository.Owner.Login, issue.Repository.Name
		}
		if issue.Number != 0 {
			d.Number = issue.Number
		}
		d.Title, d.Body = issue.Title, issue.Body
		d.State, d.Author, d.CreatedAt = normalizeState(issue.State), issue.Author.Login, issue.CreatedAt
		for _, edge := range issue.Labels.Edges {
			d.Labels = append(d.Labels, edge.Node.Name)
		}
	}
	if d.Title == "" {
		d.Title = dom.Text(issueTitle.MatchFirst(doc))
	}
	if d.Body == "" {
		d.Body = markdownBody(doc)
	}
	if d.State == "" {
		d.State = normalizeState(dom.Text(stateLabel.MatchFirst(doc)))
	}
	if d.Author == "" {
		d.Author = dom.Text(issueAuthor.MatchFirst(doc))
	}
	return d, d.Title != ""
}

func pullData(t target, emb *embedded, doc *html.Node) (Data, bool) {
	d := Data{Kind: KindPull, Owner: t.owner, Repo: t.repo, Number: t.number, Labels: []string{}, Comments: comments(doc)}
	if emb != nil {
		route := emb.Payload.PullRequestsLayoutRoute
		if route.Repository.OwnerLogin != "" {
			d.Owner, d.Repo = route.Repository.OwnerLogin, route.Repository.Name
		}
		if pr := route.PullRequest; pr != nil {
			if pr.Number != 0 {
				d.Number = pr.Number
			}
			d.Title, d.State = pr.Title, normalizeState(pr.State)
			d.Author, d.CreatedAt = pr.Author.Login, pr.CreatedTime
		}
	}
	if d.Title == "" {
		d.Title = dom.Text(cmp.Or(jsIssueTitle.MatchFirst(doc), markdownTitle.MatchFirst(doc)))
	}
	if d.State == "" {
		d.State = normalizeState(dom.Text(stateLabel.MatchFirst(doc)))
	}
	if d.Author == "" {
		d.Author = dom.Text(author.MatchFirst(doc))
	}
	// The pull request payload carries no body; the description is server
	// rendered as the first comment on the page.
	d.Body = markdownBody(doc)
	return d, d.Title != ""
}

func repoData(t target, emb *embedded, doc *html.Node) (Data, bool) {
	d := Data{Kind: KindRepo, Owner: t.owner, Repo: t.repo, Labels: []string{}, Comments: []Comment{}}
	var about string
	if emb != nil && emb.Payload.SidebarAbout != nil {
		sidebar := emb.Payload.SidebarAbout
		about = sidebar.Description
		if sidebar.RepoName != "" {
			d.Owner, d.Repo = sidebar.OwnerLogin, sidebar.RepoName
		}
		for _, topic := range sidebar.Topics {
			d.Labels = append(d.Labels, topic.Name)
		}
	} else if name := dom.Text(itemName.MatchFirst(doc)); name != "" {
		d.Repo = name
		if owner := dom.Text(itemAuthor.MatchFirst(doc)); owner != "" {
			d.Owner = owner
		}
	}
	readme := dom.Text(readmeArticle.MatchFirst(doc))
	d.Body = strings.TrimSpace(about + "\n\n" + readme)
	return d, d.Body != ""
}

func markdownBody(doc *html.Node) string {
	return dom.Text(markdown.MatchFirst(doc))
}

var (
	timelineBody   = cascadia.MustCompile(".js-comment-body, [data-testid=markdown-body]")
	timelineAuthor = cascadia.MustCompile("a.author, a[data-testid=avatar-link]")
	relativeTime   = cascadia.MustCompile("relative-time")
)

// comments reads every comment body after the description, in the React
// issue viewer and in the server-rendered pull request timeline alike. Each
// body follows its own header's author link and timestamp in document order;
// timeline events in between carry theirs too, so the last ones seen win.
func comments(doc *html.Node) []Comment {
	out := []Comment{}
	var c Comment
	description := true
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		switch {
		case timelineBody.Match(n):
			if c.Body = dom.Text(n); !description && c.Body != "" {
				out = append(out, c)
			}
			c, description = Comment{}, false
			return
		case timelineAuthor.Match(n):
			c.Author = dom.Text(n)
		case relativeTime.Match(n):
			if t, err := time.Parse(time.RFC3339, dom.Attr(n, "datetime")); err == nil {
				c.CreatedAt = t.UTC().Format(time.RFC3339)
			}
		}
		for child := n.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(doc)
	return out
}

// discussionBody is the data-url of a discussion's opening post. GitHub
// swaps the page body in place on navigation, so the discussion the body
// names is checked against the URL.
var discussionBody = regexp.MustCompile(`^/([^/]+)/([^/]+)/discussions/(\d+)/body$`)

var (
	openingPost    = cascadia.MustCompile("[data-url#=(" + discussionBody.String() + ")]")
	categoryLink   = cascadia.MustCompile(`a[href*="/discussions/categories/"]`)
	closedState    = cascadia.MustCompile(`.State[title^="Status: Closed"]`)
	discussionPost = cascadia.MustCompile(".discussions-timeline-scroll-target[id^=discussioncomment-]")
	threadReply    = cascadia.MustCompile(".js-nested-comment-container, .js-nested-comment-container *")
	ownComment     = cascadia.MustCompile(".js-discussion-comment")
	commentHeader  = cascadia.MustCompile(".timeline-comment-header-text")
	commentBody    = cascadia.MustCompile(".js-comment-body")
	chosenAnswer   = cascadia.MustCompile(".timeline-chosen-answer")
	upvoteButton   = cascadia.MustCompile(".js-upvote-button")
	link           = cascadia.MustCompile("a")
	span           = cascadia.MustCompile("span")
)

func discussionData(t target, doc *html.Node) (Data, bool) {
	d := Data{Kind: KindDiscussion, Owner: t.owner, Repo: t.repo, Number: t.number, Labels: []string{}}
	opening := openingPost.MatchFirst(doc)
	if opening == nil {
		return d, false
	}
	m := discussionBody.FindStringSubmatch(dom.Attr(opening, "data-url"))
	d.Owner, d.Repo = m[1], m[2]
	d.Number, _ = strconv.Atoi(m[3])
	post := discussionComment(opening)
	d.Author, d.Body, d.CreatedAt, d.Score = post.Author, post.Body, post.CreatedAt, post.Score
	d.Title = dom.Text(jsIssueTitle.MatchFirst(doc))
	d.Category = dom.Text(categoryLink.MatchFirst(doc))
	d.State = "open"
	if closedState.MatchFirst(doc) != nil {
		d.State = "closed"
	}
	d.Comments = discussionComments(doc)
	return d, d.Title != ""
}

// discussionComments reads the comments after the opening post in order,
// each with the replies GitHub nests in its thread.
func discussionComments(doc *html.Node) []Comment {
	out := []Comment{}
	for _, n := range discussionPost.MatchAll(doc) {
		c := discussionComment(n)
		if last := len(out) - 1; threadReply.Match(n) && last >= 0 {
			out[last].Replies = append(out[last].Replies, c)
		} else {
			out = append(out, c)
		}
	}
	return out
}

// discussionComment reads one post from its own comment group, which holds
// none of the replies threaded under it.
func discussionComment(n *html.Node) Comment {
	own := ownComment.MatchFirst(n)
	header := dom.First(own, commentHeader)
	c := Comment{
		Author: dom.Text(dom.First(header, link)),
		Body:   dom.Text(dom.First(own, commentBody)),
		Answer: dom.First(own, chosenAnswer) != nil,
	}
	stamp := dom.First(header, relativeTime)
	if t, err := time.Parse(time.RFC3339, dom.Attr(stamp, "datetime")); err == nil {
		c.CreatedAt = t.UTC().Format(time.RFC3339)
	}
	upvotes := dom.First(dom.First(own, upvoteButton), span)
	c.Score, _ = strconv.Atoi(dom.Text(upvotes))
	return c
}

func normalizeState(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

// Package github extracts repository roots, issues and pull requests from
// github.com pages.
package github

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"golang.org/x/net/html"

	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
)

const Name = "github"

const (
	KindRepo  = "repo"
	KindIssue = "issue"
	KindPull  = "pull"
)

type Data struct {
	Kind      string   `json:"kind"`
	Owner     string   `json:"owner"`
	Repo      string   `json:"repo"`
	Number    int      `json:"number"`
	Title     string   `json:"title"`
	State     string   `json:"state"`
	Author    string   `json:"author"`
	Body      string   `json:"body"`
	Labels    []string `json:"labels"`
	CreatedAt string   `json:"created_at"`
}

type Extractor struct{}

func init() { extractor.Register(Extractor{}) }

func (Extractor) Rule() extractor.Rule {
	return extractor.Rule{
		Extractor: Name,
		Version:   3,
		Hosts:     []string{"github.com"},
		PathRegex: `^/[^/]+/[^/]+(/(issues|pull)/\d+)?/?$`,
		// GitHub's own two-segment pages look like owner/repo. Some are
		// secret: /settings/tokens shows a new token in the page.
		ExcludePathRegex: `^/(settings|login|logout|sessions|session|signup|join|password_reset|account|auth|notifications|issues|pulls|orgs|organizations|new|marketplace|sponsors|apps|codespaces|copilot|github-copilot|dashboard|explore|topics|trending|collections|search|stars|users|enterprises|features|security)(/|$)`,
		Recapture:        extractor.RecaptureAfterQuiet,
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
		path = fmt.Sprintf("%s/%s/%d", path, issuePathSegment(data.Kind), data.Number)
	}
	canonical := &url.URL{Scheme: pageURL.Scheme, Host: pageURL.Host, Path: path}
	return extractor.Record{
		CanonicalURL: canonical.String(),
		Title:        title,
		SearchText:   strings.TrimSpace(strings.Join([]string{data.Title, data.Body, strings.Join(data.Labels, " ")}, "\n")),
		Data:         data,
	}, nil
}

func issuePathSegment(kind string) string {
	if kind == KindPull {
		return "pull"
	}
	return "issues"
}

var pathRe = regexp.MustCompile(`^/([^/]+)/([^/]+)(?:/(issues|pull)/(\d+))?/?$`)

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

func embeddedData(doc *html.Node) *embedded {
	script := findNode(doc, func(n *html.Node) bool {
		return n.Data == "script" && attr(n, "data-target") == "react-app.embeddedData"
	})
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
	d := Data{Kind: KindIssue, Owner: t.owner, Repo: t.repo, Number: t.number, Labels: []string{}}
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
		d.Title = nodeText(findNode(doc, byAttr("data-testid", "issue-title")))
	}
	if d.Body == "" {
		d.Body = markdownBody(doc)
	}
	if d.State == "" {
		d.State = normalizeState(nodeText(findNode(doc, byAttr("data-component", "StateLabel"))))
	}
	if d.Author == "" {
		d.Author = nodeText(findNode(doc, byAttr("data-testid", "issue-body-header-author")))
	}
	return d, d.Title != ""
}

func pullData(t target, emb *embedded, doc *html.Node) (Data, bool) {
	d := Data{Kind: KindPull, Owner: t.owner, Repo: t.repo, Number: t.number, Labels: []string{}}
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
		d.Title = nodeText(firstOf(doc, byClass("js-issue-title"), byClass("markdown-title")))
	}
	if d.State == "" {
		d.State = normalizeState(nodeText(findNode(doc, byAttr("data-component", "StateLabel"))))
	}
	if d.Author == "" {
		d.Author = nodeText(findNode(doc, byClass("author")))
	}
	// The pull request payload carries no body; the description is server
	// rendered as the first comment on the page.
	d.Body = markdownBody(doc)
	return d, d.Title != ""
}

func repoData(t target, emb *embedded, doc *html.Node) (Data, bool) {
	d := Data{Kind: KindRepo, Owner: t.owner, Repo: t.repo, Labels: []string{}}
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
	} else if name := nodeText(findNode(doc, byAttr("itemprop", "name"))); name != "" {
		d.Repo = name
		if owner := nodeText(findNode(doc, byAttr("itemprop", "author"))); owner != "" {
			d.Owner = owner
		}
	}
	readme := nodeText(findNode(doc, func(n *html.Node) bool {
		return n.Data == "article" && hasClass(n, "markdown-body")
	}))
	d.Body = strings.TrimSpace(about + "\n\n" + readme)
	return d, d.Body != ""
}

func markdownBody(doc *html.Node) string {
	return nodeText(findNode(doc, byClass("markdown-body")))
}

func normalizeState(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

func byAttr(key, value string) func(*html.Node) bool {
	return func(n *html.Node) bool { return attr(n, key) == value }
}

func byClass(class string) func(*html.Node) bool {
	return func(n *html.Node) bool { return hasClass(n, class) }
}

func firstOf(doc *html.Node, preds ...func(*html.Node) bool) *html.Node {
	for _, pred := range preds {
		if n := findNode(doc, pred); n != nil {
			return n
		}
	}
	return nil
}

func findNode(n *html.Node, pred func(*html.Node) bool) *html.Node {
	if n == nil {
		return nil
	}
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

func hasClass(n *html.Node, class string) bool {
	return slices.Contains(strings.Fields(attr(n, "class")), class)
}

var blockTags = map[string]bool{
	"article": true, "blockquote": true, "br": true, "div": true, "h1": true,
	"h2": true, "h3": true, "h4": true, "h5": true, "h6": true, "li": true,
	"ol": true, "p": true, "pre": true, "section": true, "table": true,
	"tr": true, "ul": true,
}

func nodeText(n *html.Node) string {
	if n == nil {
		return ""
	}
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		switch {
		case n.Type == html.TextNode:
			b.WriteString(n.Data)
		case n.Type == html.ElementNode && (n.Data == "script" || n.Data == "style"):
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
		if n.Type == html.ElementNode && blockTags[n.Data] {
			b.WriteByte('\n')
		}
	}
	walk(n)
	lines := strings.Split(b.String(), "\n")
	kept := lines[:0]
	for _, line := range lines {
		if line = strings.Join(strings.Fields(line), " "); line != "" {
			kept = append(kept, line)
		}
	}
	return strings.Join(kept, "\n")
}

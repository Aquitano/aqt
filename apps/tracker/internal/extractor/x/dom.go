package x

import (
	"net/url"
	"regexp"
	"strings"

	"golang.org/x/net/html"
)

// statusPath matches both the page path and a relative anchor href such as
// /handle/status/123/photo/1.
var statusPath = regexp.MustCompile(`^/([^/]+)/status/(\d+)`)

func linkStatus(href string) (handle, id string) {
	u, err := url.Parse(href)
	if err != nil {
		return "", ""
	}
	m := statusPath.FindStringSubmatch(u.Path)
	if m == nil {
		return "", ""
	}
	return m[1], m[2]
}

func attr(n *html.Node, key string) string {
	if n == nil {
		return ""
	}
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func isElem(n *html.Node, tag string) bool {
	return n.Type == html.ElementNode && n.Data == tag
}

func testID(n *html.Node, want string) bool {
	return n.Type == html.ElementNode && attr(n, "data-testid") == want
}

// each walks n in document order, never entering the subtree rooted at skip.
// visit reports whether to descend into the node it was given.
func each(n, skip *html.Node, visit func(*html.Node) bool) {
	if n == nil || n == skip {
		return
	}
	if !visit(n) {
		return
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		each(c, skip, visit)
	}
}

func find(root, skip *html.Node, pred func(*html.Node) bool) *html.Node {
	var found *html.Node
	each(root, skip, func(n *html.Node) bool {
		if found != nil {
			return false
		}
		if pred(n) {
			found = n
			return false
		}
		return true
	})
	return found
}

// findAll does not descend into a match, so a media container nested inside
// another one is counted once.
func findAll(root, skip *html.Node, pred func(*html.Node) bool) []*html.Node {
	var out []*html.Node
	each(root, skip, func(n *html.Node) bool {
		if pred(n) {
			out = append(out, n)
			return false
		}
		return true
	})
	return out
}

func ancestorLink(n *html.Node) *html.Node {
	for p := n.Parent; p != nil; p = p.Parent {
		if isElem(p, "a") {
			return p
		}
	}
	return nil
}

// text renders a subtree the way a reader sees it: img alt texts stand in for
// emoji, <br> and block boundaries become newlines.
func text(root, skip *html.Node) string {
	var b strings.Builder
	newline := func() {
		if b.Len() > 0 && !strings.HasSuffix(b.String(), "\n") {
			b.WriteByte('\n')
		}
	}
	each(root, skip, func(n *html.Node) bool {
		switch {
		case n.Type == html.TextNode:
			b.WriteString(n.Data)
		case isElem(n, "img"):
			b.WriteString(attr(n, "alt"))
		case isElem(n, "br"):
			b.WriteByte('\n')
		case isElem(n, "div") || isElem(n, "p"):
			newline()
		}
		return true
	})
	return strings.TrimSpace(b.String())
}

func collapse(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

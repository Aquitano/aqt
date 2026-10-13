package x

import (
	"net/url"
	"regexp"
	"strings"

	"github.com/andybalholm/cascadia"
	"golang.org/x/net/html"

	"github.com/aquitano/aqt/apps/tracker/internal/extractor/dom"
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

// outside narrows sel to nodes outside skip, so a post's own text, media and
// author are never read from the post it quotes.
func outside(sel cascadia.Selector, skip *html.Node) cascadia.Selector {
	return func(n *html.Node) bool {
		if !sel.Match(n) {
			return false
		}
		for p := n; p != nil; p = p.Parent {
			if p == skip {
				return false
			}
		}
		return true
	}
}

// text renders a subtree the way a reader sees it: img alt texts stand in for
// emoji, <br> and block boundaries become newlines.
func text(root *html.Node) string {
	var b strings.Builder
	newline := func() {
		if b.Len() > 0 && !strings.HasSuffix(b.String(), "\n") {
			b.WriteByte('\n')
		}
	}
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		switch n.Type {
		case html.TextNode:
			b.WriteString(n.Data)
		case html.ElementNode:
			switch n.Data {
			case "img":
				b.WriteString(dom.Attr(n, "alt"))
			case "br":
				b.WriteByte('\n')
			case "div", "p":
				newline()
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	if root != nil {
		walk(root)
	}
	return strings.TrimSpace(b.String())
}

func collapse(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// Package dom holds the HTML helpers the site extractors share.
package dom

import (
	"strings"

	"golang.org/x/net/html"
)

func Attr(n *html.Node, key string) string {
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

var blockTags = map[string]bool{
	"article": true, "blockquote": true, "br": true, "div": true, "h1": true,
	"h2": true, "h3": true, "h4": true, "h5": true, "h6": true, "li": true,
	"ol": true, "p": true, "pre": true, "section": true, "table": true,
	"tr": true, "ul": true,
}

// Text renders a subtree the way a reader sees it: every block element on
// lines of its own, whitespace collapsed within a line, empty lines dropped.
// Buttons are left out with scripts and styles: code blocks carry a "Copy"
// one.
func Text(n *html.Node) string {
	if n == nil {
		return ""
	}
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
		}
		if n.Type == html.ElementNode && (n.Data == "script" || n.Data == "style" || n.Data == "button") {
			return
		}
		block := n.Type == html.ElementNode && blockTags[n.Data]
		if block {
			b.WriteByte('\n')
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
		if block {
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

// Package fake is the extractor the tests register: it reads <title> and
// the visible text of any example.com page, and misbehaves on request so
// the worker's failure paths can be exercised.
package fake

import (
	"bytes"
	"context"
	"net/url"
	"strings"

	"golang.org/x/net/html"

	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
)

const Name = "fake"

type Extractor struct {
	Version  int
	MaxBytes int
}

type Data struct {
	Title string `json:"title"`
	Words int    `json:"words"`
}

func (e Extractor) Rule() extractor.Rule {
	return extractor.Rule{
		Extractor: Name,
		Version:   e.Version,
		Hosts:     []string{"example.com", "*.example.com"},
		PathRegex: "^/",
		QueryKeys: []string{"id"},
		MaxBytes:  e.MaxBytes,
	}
}

func (Extractor) Extract(ctx context.Context, raw []byte, pageURL *url.URL) (extractor.Record, error) {
	doc, err := html.Parse(bytes.NewReader(raw))
	if err != nil {
		return extractor.Record{}, err
	}
	var title string
	var text strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		switch {
		case n.Type == html.ElementNode && n.Data == "title" && n.FirstChild != nil:
			title = strings.TrimSpace(n.FirstChild.Data)
			return
		case n.Type == html.ElementNode && (n.Data == "script" || n.Data == "style"):
			return
		case n.Type == html.TextNode:
			text.WriteString(n.Data)
			text.WriteByte(' ')
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	switch title {
	case "":
		return extractor.Record{}, extractor.ErrNoMatch
	case "panic":
		panic("fake extractor asked to panic")
	case "hang":
		<-ctx.Done()
		return extractor.Record{}, ctx.Err()
	}
	// No HTML parser lets NUL through, but an extractor reading JSON embedded
	// in the page can return one; `\0` in the page stands in for it.
	title = strings.ReplaceAll(title, `\0`, "\x00")
	words := strings.Fields(strings.ReplaceAll(text.String(), `\0`, "\x00"))
	canonical := &url.URL{Scheme: pageURL.Scheme, Host: pageURL.Host, Path: pageURL.Path}
	return extractor.Record{
		CanonicalURL: canonical.String(),
		Title:        title,
		SearchText:   strings.Join(words, " "),
		Data:         Data{Title: title, Words: len(words)},
	}, nil
}

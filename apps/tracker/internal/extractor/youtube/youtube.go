// Package youtube extracts a video's metadata from a youtube.com watch page.
package youtube

import (
	"bytes"
	"context"
	"encoding/json"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/net/html"

	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
)

const Name = "youtube"

type Data struct {
	VideoID         string   `json:"video_id"`
	Title           string   `json:"title"`
	Channel         string   `json:"channel"`
	ChannelID       string   `json:"channel_id"`
	DurationSeconds int      `json:"duration_seconds"`
	Published       string   `json:"published"`
	Description     string   `json:"description"`
	ViewCount       int64    `json:"view_count"`
	Keywords        []string `json:"keywords"`
}

type Extractor struct{}

func init() { extractor.Register(Extractor{}) }

func (Extractor) Rule() extractor.Rule {
	return extractor.Rule{
		Extractor: Name,
		Version:   1,
		Hosts:     []string{"www.youtube.com", "youtube.com"},
		PathRegex: `^/watch$`,
		QueryKeys: []string{"v"},
	}
}

func (Extractor) Extract(_ context.Context, raw []byte, pageURL *url.URL) (extractor.Record, error) {
	doc, err := html.Parse(bytes.NewReader(raw))
	if err != nil {
		return extractor.Record{}, err
	}
	data, ok := playerData(doc)
	if !ok {
		data, ok = microdata(doc)
	}
	if !ok {
		return extractor.Record{}, extractor.ErrNoMatch
	}
	return extractor.Record{
		CanonicalURL: "https://www.youtube.com/watch?v=" + data.VideoID,
		Title:        data.Title,
		SearchText: strings.TrimSpace(strings.Join(
			[]string{data.Title, data.Channel, data.Description, strings.Join(data.Keywords, " ")}, "\n")),
		Data: data,
	}, nil
}

type playerResponse struct {
	VideoDetails struct {
		VideoID          string   `json:"videoId"`
		Title            string   `json:"title"`
		Author           string   `json:"author"`
		ChannelID        string   `json:"channelId"`
		LengthSeconds    string   `json:"lengthSeconds"`
		ShortDescription string   `json:"shortDescription"`
		ViewCount        string   `json:"viewCount"`
		Keywords         []string `json:"keywords"`
	} `json:"videoDetails"`
	Microformat struct {
		PlayerMicroformatRenderer struct {
			PublishDate string `json:"publishDate"`
		} `json:"playerMicroformatRenderer"`
	} `json:"microformat"`
}

const playerMarker = "ytInitialPlayerResponse"

func playerData(doc *html.Node) (Data, bool) {
	var pr playerResponse
	script := findNode(doc, func(n *html.Node) bool {
		return n.Data == "script" && n.FirstChild != nil && strings.Contains(n.FirstChild.Data, playerMarker)
	})
	if script == nil {
		return Data{}, false
	}
	obj, ok := jsonObject(script.FirstChild.Data, playerMarker)
	if !ok {
		return Data{}, false
	}
	if err := json.Unmarshal([]byte(obj), &pr); err != nil {
		return Data{}, false
	}
	details := pr.VideoDetails
	if details.VideoID == "" {
		return Data{}, false
	}
	length, _ := strconv.Atoi(details.LengthSeconds)
	views, _ := strconv.ParseInt(details.ViewCount, 10, 64)
	keywords := details.Keywords
	if keywords == nil {
		keywords = []string{}
	}
	return Data{
		VideoID:         details.VideoID,
		Title:           details.Title,
		Channel:         details.Author,
		ChannelID:       details.ChannelID,
		DurationSeconds: length,
		Published:       isoDate(pr.Microformat.PlayerMicroformatRenderer.PublishDate),
		Description:     details.ShortDescription,
		ViewCount:       views,
		Keywords:        keywords,
	}, true
}

// jsonObject returns the first brace-balanced object that starts after
// marker. Braces inside string literals are skipped, so a description
// containing "{" does not truncate the object.
func jsonObject(s, marker string) (string, bool) {
	from := strings.Index(s, marker)
	if from < 0 {
		return "", false
	}
	start := strings.Index(s[from:], "{")
	if start < 0 {
		return "", false
	}
	start += from
	depth, inString, escaped := 0, false, false
	for i := start; i < len(s); i++ {
		c := s[i]
		switch {
		case escaped:
			escaped = false
		case c == '\\' && inString:
			escaped = true
		case c == '"':
			inString = !inString
		case inString:
		case c == '{':
			depth++
		case c == '}':
			depth--
			if depth == 0 {
				return s[start : i+1], true
			}
		}
	}
	return "", false
}

func microdata(doc *html.Node) (Data, bool) {
	id := itemprop(doc, "identifier")
	if id == "" {
		return Data{}, false
	}
	d := Data{
		VideoID:         id,
		Title:           itemprop(doc, "name"),
		Description:     itemprop(doc, "description"),
		DurationSeconds: parseISODuration(itemprop(doc, "duration")),
		Published:       isoDate(itemprop(doc, "datePublished")),
		Keywords:        []string{},
	}
	if author := findNode(doc, byAttr("itemprop", "author")); author != nil {
		d.Channel = itemprop(author, "name")
	}
	if keywords := itemprop(doc, "keywords"); keywords != "" {
		d.Keywords = strings.Split(keywords, ",")
	}
	d.ViewCount = interactionCount(doc, "https://schema.org/WatchAction")
	return d, true
}

// itemprop reads the content of a microdata <meta>/<link>; YouTube puts the
// channel name in a <link itemprop="name" content=...>, which is not a link.
func itemprop(root *html.Node, name string) string {
	n := findNode(root, byAttr("itemprop", name))
	if n == nil {
		return ""
	}
	return attr(n, "content")
}

func interactionCount(doc *html.Node, interactionType string) int64 {
	stat := findNode(doc, func(n *html.Node) bool {
		return attr(n, "itemprop") == "interactionStatistic" &&
			itemprop(n, "interactionType") == interactionType
	})
	count, _ := strconv.ParseInt(itemprop(stat, "userInteractionCount"), 10, 64)
	return count
}

var durationRe = regexp.MustCompile(`^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$`)

func parseISODuration(s string) int {
	m := durationRe.FindStringSubmatch(s)
	if m == nil {
		return 0
	}
	units := []int{3600, 60, 1}
	total := 0
	for i, unit := range units {
		n, _ := strconv.Atoi(m[i+1])
		total += n * unit
	}
	return total
}

func isoDate(s string) string {
	if len(s) < 10 {
		return ""
	}
	return s[:10]
}

func byAttr(key, value string) func(*html.Node) bool {
	return func(n *html.Node) bool { return attr(n, key) == value }
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

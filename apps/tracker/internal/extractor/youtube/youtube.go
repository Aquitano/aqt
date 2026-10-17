// Package youtube extracts a video's metadata, and the transcript the
// extension attaches, from a youtube.com watch page.
package youtube

import (
	"bytes"
	"context"
	"encoding/json"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/andybalholm/cascadia"
	"golang.org/x/net/html"

	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
	"github.com/aquitano/aqt/apps/tracker/internal/extractor/dom"
)

const Name = "youtube"

type Data struct {
	VideoID         string      `json:"video_id"`
	Title           string      `json:"title"`
	Channel         string      `json:"channel"`
	ChannelID       string      `json:"channel_id"`
	DurationSeconds int         `json:"duration_seconds"`
	Published       string      `json:"published"`
	Description     string      `json:"description"`
	Keywords        []string    `json:"keywords"`
	Transcript      *Transcript `json:"transcript,omitempty"`
}

type Transcript struct {
	Language string `json:"language"`
	Kind     string `json:"kind"`
	Text     string `json:"text"`
}

type Extractor struct{}

func init() { extractor.Register(Extractor{}) }

func (Extractor) Rule() extractor.Rule {
	return extractor.Rule{
		Extractor: Name,
		Version:   5,
		// Every subdomain, so studio and music pages never fall through to
		// the article fallback.
		Hosts:     []string{"youtube.com", "*.youtube.com"},
		PathRegex: `^/watch$`,
		QueryKeys: []string{"v"},
	}
}

func (Extractor) Extract(_ context.Context, raw []byte, pageURL *url.URL) (extractor.Record, error) {
	doc, err := html.Parse(bytes.NewReader(raw))
	if err != nil {
		return extractor.Record{}, err
	}
	data, err := currentVideo(doc, pageURL.Query().Get("v"))
	if err != nil {
		return extractor.Record{}, err
	}
	data.Transcript = transcript(doc, data.VideoID)
	searchText := []string{data.Title, data.Channel, data.Description, strings.Join(data.Keywords, " ")}
	if data.Transcript != nil {
		searchText = append(searchText, data.Transcript.Text)
	}
	return extractor.Record{
		CanonicalURL: "https://www.youtube.com/watch?v=" + data.VideoID,
		Title:        data.Title,
		SearchText:   strings.TrimSpace(strings.Join(searchText, "\n")),
		Data:         data,
	}, nil
}

var transcriptScript = cascadia.MustCompile("script#tracker-transcript")

// The extension appends the transcript YouTube loaded for the video it was
// showing, which after in-app navigation can be another video than the one
// read here; only the text is kept, the timestamps stay in the blob.
func transcript(doc *html.Node, videoID string) *Transcript {
	script := transcriptScript.MatchFirst(doc)
	if script == nil || script.FirstChild == nil {
		return nil
	}
	var attached struct {
		VideoID  string `json:"video_id"`
		Language string `json:"language"`
		Kind     string `json:"kind"`
		Segments []struct {
			Text string `json:"text"`
		} `json:"segments"`
	}
	if err := json.Unmarshal([]byte(script.FirstChild.Data), &attached); err != nil || attached.VideoID != videoID {
		return nil
	}
	lines := make([]string, 0, len(attached.Segments))
	for _, segment := range attached.Segments {
		lines = append(lines, segment.Text)
	}
	text := strings.Join(strings.Fields(strings.Join(lines, " ")), " ")
	if text == "" {
		return nil
	}
	return &Transcript{Language: attached.Language, Kind: attached.Kind, Text: text}
}

// YouTube navigation can leave the previous video in scripts and microdata.
// Read the live watch metadata only beneath the requested video identity.
func currentVideo(doc *html.Node, videoID string) (Data, error) {
	err := extractor.ErrNoMatch
	for _, read := range []func(*html.Node) (Data, bool){playerData, microdata} {
		data, ok := read(doc)
		switch {
		case !ok:
		case data.VideoID == videoID:
			return data, nil
		default:
			err = extractor.ErrStale
		}
	}
	if data, ok := watchData(doc, videoID); ok {
		return data, nil
	}
	return Data{}, err
}

var (
	watchFlexy          = cascadia.MustCompile("ytd-watch-flexy")
	watchMetadata       = cascadia.MustCompile("ytd-watch-metadata")
	heading             = cascadia.MustCompile("h1")
	formattedString     = cascadia.MustCompile("yt-formatted-string")
	videoOwner          = cascadia.MustCompile("ytd-video-owner-renderer")
	channelName         = cascadia.MustCompile("#channel-name")
	link                = cascadia.MustCompile("a")
	descriptionExpander = cascadia.MustCompile("#description-inline-expander")
	expanded            = cascadia.MustCompile("#expanded")
	snippet             = cascadia.MustCompile("#snippet-text")
)

func watchData(doc *html.Node, videoID string) (Data, bool) {
	if videoID == "" {
		return Data{}, false
	}
	watch := ofVideo(watchFlexy, videoID).MatchFirst(doc)
	metadata := ofVideo(watchMetadata, videoID).MatchFirst(doc)
	if metadata == nil {
		metadata = dom.First(watch, ofVideo(watchMetadata, "", videoID))
	}
	title := nodeText(dom.First(dom.First(metadata, heading), formattedString))
	if title == "" {
		return Data{}, false
	}
	owner := videoOwner.MatchFirst(metadata)
	channel := nodeText(dom.First(dom.First(owner, channelName), link))
	description := descriptionExpander.MatchFirst(metadata)
	text := nodeText(dom.First(description, expanded))
	if text == "" {
		text = nodeText(dom.First(description, snippet))
	}
	return Data{VideoID: videoID, Title: title, Channel: channel, Description: text, Keywords: []string{}}, true
}

// ofVideo narrows sel to elements whose video-id is one of ids.
func ofVideo(sel cascadia.Selector, ids ...string) cascadia.Selector {
	return func(n *html.Node) bool {
		return sel.Match(n) && slices.Contains(ids, dom.Attr(n, "video-id"))
	}
}

func nodeText(n *html.Node) string {
	var text strings.Builder
	var visit func(*html.Node)
	visit = func(n *html.Node) {
		if n == nil || n.Data == "script" || n.Data == "style" || n.Data == "template" {
			return
		}
		if n.Type == html.TextNode {
			text.WriteString(n.Data)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			visit(c)
		}
	}
	visit(n)
	return strings.TrimSpace(text.String())
}

type playerResponse struct {
	VideoDetails struct {
		VideoID          string   `json:"videoId"`
		Title            string   `json:"title"`
		Author           string   `json:"author"`
		ChannelID        string   `json:"channelId"`
		LengthSeconds    string   `json:"lengthSeconds"`
		ShortDescription string   `json:"shortDescription"`
		Keywords         []string `json:"keywords"`
	} `json:"videoDetails"`
	Microformat struct {
		PlayerMicroformatRenderer struct {
			PublishDate string `json:"publishDate"`
		} `json:"playerMicroformatRenderer"`
	} `json:"microformat"`
}

const playerMarker = "ytInitialPlayerResponse"

var playerScript = cascadia.MustCompile("script:matches(" + playerMarker + ")")

func playerData(doc *html.Node) (Data, bool) {
	var pr playerResponse
	script := playerScript.MatchFirst(doc)
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

var (
	identifierProp    = cascadia.MustCompile("[itemprop=identifier]")
	nameProp          = cascadia.MustCompile("[itemprop=name]")
	descriptionProp   = cascadia.MustCompile("[itemprop=description]")
	durationProp      = cascadia.MustCompile("[itemprop=duration]")
	datePublishedProp = cascadia.MustCompile("[itemprop=datePublished]")
	authorProp        = cascadia.MustCompile("[itemprop=author]")
	keywordsProp      = cascadia.MustCompile("[itemprop=keywords]")
)

func microdata(doc *html.Node) (Data, bool) {
	id := itemprop(doc, identifierProp)
	if id == "" {
		return Data{}, false
	}
	d := Data{
		VideoID:         id,
		Title:           itemprop(doc, nameProp),
		Description:     itemprop(doc, descriptionProp),
		DurationSeconds: parseISODuration(itemprop(doc, durationProp)),
		Published:       isoDate(itemprop(doc, datePublishedProp)),
		Keywords:        []string{},
	}
	if author := authorProp.MatchFirst(doc); author != nil {
		d.Channel = itemprop(author, nameProp)
	}
	if keywords := itemprop(doc, keywordsProp); keywords != "" {
		d.Keywords = strings.Split(keywords, ",")
	}
	return d, true
}

// itemprop reads the content of a microdata <meta>/<link>; YouTube puts the
// channel name in a <link itemprop="name" content=...>, which is not a link.
func itemprop(root *html.Node, prop cascadia.Selector) string {
	return dom.Attr(prop.MatchFirst(root), "content")
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

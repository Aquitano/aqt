// Package whatsapp parses WhatsApp "Export chat" text files (Android and iOS
// layouts, 12h and 24h clocks) and imports them into the archive.
package whatsapp

import (
	"bufio"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type ParsedMessage struct {
	Sender         string
	Body           string
	SentAt         time.Time
	AttachmentName string
}

var (
	// 31/12/23, 21:41 - Alice: hey   |   12/31/23, 9:41 PM - Alice: hey
	androidHeader = regexp.MustCompile(`^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?\s+-\s(.*)$`)
	// [31.12.23, 21:41:32] Alice: hey
	iosHeader = regexp.MustCompile(`^\[(\d{1,2})[./-](\d{1,2})[./-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?\]\s?(.*)$`)

	iosAttachment     = regexp.MustCompile(`<attached:\s*([^>]+)>`)
	androidAttachment = regexp.MustCompile(`^(\S[^\n]*?)\s\(file attached\)$`)
	mediaOmitted      = regexp.MustCompile(`^<?(?:Media omitted|image omitted|video omitted|audio omitted|sticker omitted|GIF omitted|document omitted)>?$`)

	// Localized exports write the same two shapes with the words translated
	// ("<Anhang: x.jpg>", "x.jpg (Datei angehängt)"). These looser forms are
	// trusted only when the named file actually exists in the export's own
	// media set, so they cannot invent an attachment out of message text.
	iosAttachmentAnyWord     = regexp.MustCompile(`<[^:<>]+:\s*([^>]+)>`)
	androidAttachmentAnyWord = regexp.MustCompile(`^(\S[^\n]*?)\s\([^()]+\)$`)

	// Direction marks and narrow spaces WhatsApp sprinkles into exports.
	invisibles = strings.NewReplacer(
		"\u200e", "", // left-to-right mark
		"\u200f", "", // right-to-left mark
		"\ufeff", "", // BOM
		"\u202f", " ", // narrow no-break space (before AM/PM on iOS)
		"\u00a0", " ",
	)
)

type rawLine struct {
	header         bool
	a, b, year     int
	hour, min, sec int
	ampm, rest     string
}

// ParseChat reads one exported chat. Date order (DD/MM vs MM/DD) is detected
// by scanning the whole file; ambiguous files default to day-first. hasMedia
// reports whether a filename exists in the export's media set and unlocks the
// localized attachment forms; nil recognizes English markers only.
func ParseChat(r io.Reader, hasMedia func(string) bool) ([]ParsedMessage, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	var lines []rawLine
	dayFirst, monthFirst := false, false
	for scanner.Scan() {
		text := invisibles.Replace(scanner.Text())
		m := androidHeader.FindStringSubmatch(text)
		if m == nil {
			m = iosHeader.FindStringSubmatch(text)
		}
		if m == nil {
			lines = append(lines, rawLine{rest: text})
			continue
		}
		l := rawLine{header: true, ampm: strings.ToUpper(strings.ReplaceAll(m[7], ".", "")), rest: m[8]}
		l.a, _ = strconv.Atoi(m[1])
		l.b, _ = strconv.Atoi(m[2])
		l.year, _ = strconv.Atoi(m[3])
		l.hour, _ = strconv.Atoi(m[4])
		l.min, _ = strconv.Atoi(m[5])
		if m[6] != "" {
			l.sec, _ = strconv.Atoi(m[6])
		}
		if l.a > 12 {
			dayFirst = true
		}
		if l.b > 12 {
			monthFirst = true
		}
		lines = append(lines, l)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if dayFirst && monthFirst {
		// Contradictory evidence; trust the more common day-first layout.
		monthFirst = false
	}

	var out []ParsedMessage
	skipping := true
	for _, l := range lines {
		if !l.header {
			if !skipping && len(out) > 0 {
				out[len(out)-1].Body += "\n" + l.rest
			}
			continue
		}
		sender, body, ok := strings.Cut(l.rest, ": ")
		if !ok || sender == "" {
			skipping = true // system line: "Messages are end-to-end encrypted", subject changes, etc.
			continue
		}
		skipping = false

		day, month := l.a, l.b
		if monthFirst {
			day, month = l.b, l.a
		}
		year := l.year
		if year < 100 {
			year += 2000
		}
		hour := l.hour
		switch l.ampm {
		case "PM":
			if hour != 12 {
				hour += 12
			}
		case "AM":
			if hour == 12 {
				hour = 0
			}
		}

		msg := ParsedMessage{
			Sender: strings.TrimSpace(sender),
			SentAt: time.Date(year, time.Month(month), day, hour, l.min, l.sec, 0, time.Local),
		}
		msg.Body, msg.AttachmentName = extractAttachment(strings.TrimSpace(body), hasMedia)
		out = append(out, msg)
	}

	// Attachment markers on continuation lines (iOS captions) and trailing space cleanup.
	for i := range out {
		if out[i].AttachmentName == "" {
			out[i].Body, out[i].AttachmentName = extractAttachment(out[i].Body, hasMedia)
		}
		out[i].Body = strings.TrimSpace(out[i].Body)
	}
	return out, nil
}

func extractAttachment(body string, hasMedia func(string) bool) (string, string) {
	if m := iosAttachment.FindStringSubmatch(body); m != nil {
		rest := strings.TrimSpace(strings.Replace(body, m[0], "", 1))
		return rest, strings.TrimSpace(m[1])
	}
	first, rest, _ := strings.Cut(body, "\n")
	if m := androidAttachment.FindStringSubmatch(strings.TrimSpace(first)); m != nil {
		return strings.TrimSpace(rest), m[1]
	}
	if hasMedia == nil {
		return body, ""
	}
	if m := iosAttachmentAnyWord.FindStringSubmatch(body); m != nil {
		if name := strings.TrimSpace(m[1]); hasMedia(name) {
			return strings.TrimSpace(strings.Replace(body, m[0], "", 1)), name
		}
	}
	if m := androidAttachmentAnyWord.FindStringSubmatch(strings.TrimSpace(first)); m != nil && hasMedia(m[1]) {
		return strings.TrimSpace(rest), m[1]
	}
	return body, ""
}

// IsMediaOmitted reports whether a body is just the placeholder WhatsApp
// writes when a chat was exported without media.
func IsMediaOmitted(body string) bool {
	return mediaOmitted.MatchString(strings.TrimSpace(body))
}

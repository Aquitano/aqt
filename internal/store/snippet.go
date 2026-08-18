package store

import (
	"html"
	"strings"
	"unicode"
	"unicode/utf8"
)

// snippetChars bounds the window pg_search cuts around a match. Wide enough to
// read as a sentence, narrow enough that 500 results stay skimmable.
const snippetChars = 240

// Snippet turns pg_search's highlight into plain text, falling back to a
// locally cut window when the engine has none.
//
// paradedb.snippet only produces output for exact-token matches, so every
// fuzzy search — the default — comes back empty; so does a hit that matched
// only the subject or the sender. Cutting the window in Go keeps the field
// meaningful in those cases instead of silently blank.
//
// The engine escapes its output as HTML, and is asked for empty highlight
// tags, so unescaping is lossless and the result carries no markup: safe to
// print in a terminal, to embed in a page, or to hand an agent as JSON.
func Snippet(fromEngine, body, query string) string {
	if s := strings.TrimSpace(html.UnescapeString(fromEngine)); s != "" {
		return collapse(s)
	}
	return localSnippet(body, query)
}

// localSnippet cuts the window on rune boundaries. Byte offsets would split a
// multi-byte rune — Japanese and emoji bodies are the everyday case — leaving
// invalid UTF-8 that reaches a terminal raw and JSON as U+FFFD.
func localSnippet(body, query string) string {
	body = collapse(body)
	if body == "" {
		return ""
	}
	start := 0
	if i := firstTermIndex(body, query); i > 0 {
		if s := backRunes(body, i, snippetChars/2); s > 0 {
			start = s
			// Do not cut mid-word when a space is close by.
			if j := strings.IndexByte(body[start:], ' '); j >= 0 && j < 20 {
				start += j + 1
			}
		}
	}
	out := body[start:]
	if cut, truncated := headRunes(out, snippetChars); truncated {
		out = cut
		if j := strings.LastIndexByte(out, ' '); j > len(out)/2 {
			out = out[:j]
		}
		out += "…"
	}
	if start > 0 {
		out = "…" + out
	}
	return out
}

// backRunes returns the byte offset n runes before the byte offset i.
func backRunes(s string, i, n int) int {
	for range n {
		if i <= 0 {
			return 0
		}
		_, size := utf8.DecodeLastRuneInString(s[:i])
		i -= size
	}
	return i
}

// headRunes returns the first n runes of s, and whether anything was cut.
func headRunes(s string, n int) (string, bool) {
	i := 0
	for range n {
		if i >= len(s) {
			return s, false
		}
		_, size := utf8.DecodeRuneInString(s[i:])
		i += size
	}
	if i >= len(s) {
		return s, false
	}
	return s[:i], true
}

// firstTermIndex finds the earliest case-insensitive occurrence of any query
// word, or -1. Matching whole words only keeps a two-letter term from anchoring
// the window on the middle of an unrelated one.
func firstTermIndex(body, query string) int {
	lowerBody := strings.ToLower(body)
	best := -1
	for _, term := range strings.FieldsFunc(strings.ToLower(query), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	}) {
		for at := 0; ; {
			i := strings.Index(lowerBody[at:], term)
			if i < 0 {
				break
			}
			i += at
			if wordBoundary(lowerBody, i, len(term)) {
				if best < 0 || i < best {
					best = i
				}
				break
			}
			at = i + 1
		}
	}
	return best
}

func wordBoundary(s string, start, length int) bool {
	before := start == 0 || !isWordByte(s[start-1])
	after := start+length >= len(s) || !isWordByte(s[start+length])
	return before && after
}

func isWordByte(b byte) bool {
	return b >= 0x80 || unicode.IsLetter(rune(b)) || unicode.IsDigit(rune(b))
}

func collapse(s string) string { return strings.Join(strings.Fields(s), " ") }

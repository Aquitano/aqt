// Package search is the one query model every kind of record is searched
// with. A query string is parsed once into words and quoted phrases, and each
// kind turns the parsed query into a pg_search clause over its own fields.
package search

import (
	"fmt"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/aquitano/aqt/apps/bank/internal/fail"
)

type Mode string

const (
	// All requires every word and phrase, each in any of a kind's fields.
	All Mode = "all"
	// Any requires one of them; more matches rank higher.
	Any Mode = "any"
)

const (
	MaxTerms = 32
	MaxBytes = 4096
)

// Term is a bare word or a quoted phrase. A quoted single word is matched
// exactly, without typo tolerance.
type Term struct {
	Text   string
	Phrase bool
}

type Query struct {
	Terms []Term
	Mode  Mode
}

// Parse reads words separated by spaces and phrases between double quotes. An
// unclosed quote runs to the end. Pieces without a letter or digit are
// dropped, because no tokenizer indexes them and an all-words query would
// otherwise require something nothing can match.
func Parse(s string, mode Mode) (Query, error) {
	switch mode {
	case "":
		mode = All
	case All, Any:
	default:
		return Query{}, fail.Invalidf("match must be all or any")
	}
	if len(s) > MaxBytes {
		return Query{}, fail.Invalidf("query exceeds %d bytes", MaxBytes)
	}
	q := Query{Mode: mode}
	add := func(text string, phrase bool) {
		words := strings.Fields(text)
		if !slices.ContainsFunc(words, searchable) {
			return
		}
		q.Terms = append(q.Terms, Term{Text: strings.Join(words, " "), Phrase: phrase})
	}
	rest := s
	for {
		before, after, quoted := strings.Cut(rest, `"`)
		for _, word := range strings.Fields(before) {
			add(word, false)
		}
		if !quoted {
			break
		}
		phrase, tail, _ := strings.Cut(after, `"`)
		add(phrase, true)
		rest = tail
	}
	if len(q.Terms) == 0 {
		if strings.TrimSpace(s) == "" {
			return q, fail.Invalidf("search query must not be empty")
		}
		return q, fail.Invalidf("search query has no letters or digits")
	}
	if len(q.Terms) > MaxTerms {
		return q, fail.Invalidf("a search takes at most %d words and phrases", MaxTerms)
	}
	return q, nil
}

func searchable(word string) bool {
	return strings.ContainsFunc(word, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) })
}

// Distance is the number of typos a word tolerates: none up to four
// characters, where one edit turns most words into other words, one up to
// eight, two beyond.
func Distance(word string) int {
	switch n := utf8.RuneCountInString(word); {
	case n <= 4:
		return 0
	case n <= 8:
		return 1
	default:
		return 2
	}
}

// String writes the query back in its own grammar.
func (q Query) String() string {
	parts := make([]string, len(q.Terms))
	for i, t := range q.Terms {
		parts[i] = t.Text
		if t.Phrase {
			parts[i] = `"` + t.Text + `"`
		}
	}
	return strings.Join(parts, " ")
}

// Words are the query's words and the words of its phrases, for cutting a
// snippet where the engine gave none.
func (q Query) Words() []string {
	var words []string
	for _, t := range q.Terms {
		words = append(words, strings.Fields(t.Text)...)
	}
	return words
}

// Field is one indexed field a kind matches words in.
type Field struct {
	Name  string
	Boost int
	// Fragment marks a trigram field: a word of three or more characters
	// matches when all its trigrams are there, with no typo tolerance and no
	// phrases.
	Fragment bool
}

// Clause is the pg_search query for q over fields, with values bound
// through next. pg_search scores a fuzzy match as a constant, larger than most
// BM25 scores, so a word's typo-tolerant clause carries a tenth of its exact
// clause's boost: BM25 ranks the exact matches, and the fuzzy clause only lets
// a misspelt word match at all. Every word in a field is required, so
// "foo-bar" needs both foo and bar there.
func (q Query) Clause(fields []Field, next func(any) string) string {
	terms := make([]string, 0, len(q.Terms))
	for _, t := range q.Terms {
		value := next(t.Text)
		single := !strings.Contains(t.Text, " ")
		var parts []string
		for _, f := range fields {
			boost := float64(max(f.Boost, 1))
			switch {
			case f.Fragment:
				if !t.Phrase && utf8.RuneCountInString(t.Text) >= 3 {
					parts = append(parts, fmt.Sprintf("paradedb.boost(%g, paradedb.match('%s', %s, conjunction_mode => true))", boost, f.Name, value))
				}
			case t.Phrase && !single:
				parts = append(parts, fmt.Sprintf("paradedb.boost(%g, paradedb.phrase('%s', %s))", boost, f.Name, value))
			default:
				parts = append(parts, fmt.Sprintf("paradedb.boost(%g, paradedb.match('%s', %s, conjunction_mode => true))", boost, f.Name, value))
				if d := Distance(t.Text); !t.Phrase && d > 0 {
					parts = append(parts, fmt.Sprintf("paradedb.boost(%g, paradedb.match('%s', %s, distance => %d, conjunction_mode => true))", boost/10, f.Name, value, d))
				}
			}
		}
		terms = append(terms, "paradedb.boolean(should => array["+strings.Join(parts, ", ")+"])")
	}
	if len(terms) == 1 {
		return terms[0]
	}
	mode := "must"
	if q.Mode == Any {
		mode = "should"
	}
	return "paradedb.boolean(" + mode + " => array[" + strings.Join(terms, ", ") + "])"
}

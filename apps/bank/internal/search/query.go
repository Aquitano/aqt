// Package search is the one query model every kind of record is searched
// with. A query string is parsed once into words, quoted phrases and
// exclusions, and each kind turns the parsed query into a pg_search clause
// over its own fields.
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
	// Best ranks records with every word and phrase first, then records with
	// only some of them, as web search engines do.
	Best Mode = "best"
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
// exactly, without typo tolerance. An excluded term keeps every record that
// holds it out of the results.
type Term struct {
	Text    string
	Phrase  bool
	Exclude bool
}

type Query struct {
	Terms []Term
	Mode  Mode
	// Exact turns typo tolerance off for every word, as quoting each would.
	Exact bool
}

// Parse reads words separated by spaces and phrases between double quotes. An
// unclosed quote runs to the end. A leading - excludes a word or phrase.
// Pieces without a letter or digit are dropped, because no tokenizer indexes
// them and an all-words query would otherwise require something nothing can
// match.
func Parse(s string, mode Mode) (Query, error) {
	switch mode {
	case "":
		mode = Best
	case Best, All, Any:
	default:
		return Query{}, fail.Invalidf("match must be best, all or any")
	}
	if len(s) > MaxBytes {
		return Query{}, fail.Invalidf("query exceeds %d bytes", MaxBytes)
	}
	q := Query{Mode: mode}
	add := func(text string, phrase, exclude bool) {
		words := strings.Fields(text)
		if !slices.ContainsFunc(words, searchable) {
			return
		}
		q.Terms = append(q.Terms, Term{Text: strings.Join(words, " "), Phrase: phrase, Exclude: exclude})
	}
	rest := s
	for {
		before, after, quoted := strings.Cut(rest, `"`)
		fields := strings.Fields(before)
		excludePhrase := quoted && len(fields) > 0 && fields[len(fields)-1] == "-" && strings.HasSuffix(before, "-")
		for _, word := range fields {
			text, exclude := strings.CutPrefix(word, "-")
			add(text, false, exclude)
		}
		if !quoted {
			break
		}
		phrase, tail, _ := strings.Cut(after, `"`)
		add(phrase, true, excludePhrase)
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
	if q.Wanted() == 0 {
		return q, fail.Invalidf("a search needs a word or phrase to find, not only ones to exclude")
	}
	return q, nil
}

// Wanted counts the words and phrases a record is searched for, leaving out
// the excluded ones.
func (q Query) Wanted() int {
	n := 0
	for _, t := range q.Terms {
		if !t.Exclude {
			n++
		}
	}
	return n
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
		if t.Exclude {
			parts[i] = "-" + parts[i]
		}
	}
	return strings.Join(parts, " ")
}

// Words are the query's words and the words of its phrases, for cutting a
// snippet where the engine gave none. Excluded terms are not among them.
func (q Query) Words() []string {
	var words []string
	for _, t := range q.Terms {
		if !t.Exclude {
			words = append(words, strings.Fields(t.Text)...)
		}
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
// "foo-bar" needs both foo and bar there. Best match accepts any term and
// multiplies the score of a record holding all of them by bestBoost, so within
// one list those come first.
func (q Query) Clause(fields []Field, next func(any) string) string {
	var wanted, excluded []string
	for _, t := range q.Terms {
		clause := q.term(t, fields, next)
		if t.Exclude {
			excluded = append(excluded, clause)
		} else {
			wanted = append(wanted, clause)
		}
	}
	clause := wanted[0]
	if len(wanted) > 1 {
		all := "paradedb.boolean(must => array[" + strings.Join(wanted, ", ") + "])"
		switch q.Mode {
		case All:
			clause = all
		case Any:
			clause = "paradedb.boolean(should => array[" + strings.Join(wanted, ", ") + "])"
		default:
			clause = "paradedb.boolean(should => array[" + fmt.Sprintf("paradedb.boost(%d, %s)", bestBoost, all) + ", " + strings.Join(wanted, ", ") + "])"
		}
	}
	if len(excluded) == 0 {
		return clause
	}
	return "paradedb.boolean(must => array[" + clause + "], must_not => array[" + strings.Join(excluded, ", ") + "])"
}

const bestBoost = 10

func (q Query) term(t Term, fields []Field, next func(any) string) string {
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
			if d := Distance(t.Text); !t.Phrase && !t.Exclude && !q.Exact && d > 0 {
				parts = append(parts, fmt.Sprintf("paradedb.boost(%g, paradedb.match('%s', %s, distance => %d, conjunction_mode => true))", boost/10, f.Name, value, d))
			}
		}
	}
	return "paradedb.boolean(should => array[" + strings.Join(parts, ", ") + "])"
}

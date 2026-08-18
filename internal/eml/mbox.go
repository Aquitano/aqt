package eml

import (
	"bufio"
	"bytes"
	"io"
	"regexp"
)

// mboxEnvelope matches the "From " line that separates messages in every mbox
// variant in the wild: the literal word From, one whitespace-free address
// token (Thunderbird writes a bare "-"), then an asctime date, optionally with
// a zone before the year — numeric as Gmail Takeout writes it, alphabetic
// ("MET", "GMT", "PDT") as procmail, pine and mail.local do.
//
// Recognising the envelope by shape rather than by "the previous line was
// blank" is what lets a message whose body ends without a trailing newline be
// followed by another message, while ordinary unquoted body text starting with
// "From " (mboxo producers do not quote it) stays part of the body.
//
// The trade-off that leaves: an unescaped body line with the full envelope
// shape — a pasted git format-patch header is the realistic case — splits one
// message into two, which misattributes text but loses no bytes. Demanding a
// blank line before the separator would trade that for merging a message into
// its successor, which loses whole messages.
var mboxEnvelope = regexp.MustCompile(
	`^From \S+ +[A-Za-z]{3} +[A-Za-z]{3} +\d{1,2} +\d{1,2}:\d{2}(:\d{2})?( +([+-]\d{4}|[A-Za-z]{2,5}))? +\d{4}`)

// mboxEnvelopeLoose recognises an envelope by its head alone, stopping before
// the zone and year that dialects disagree about. Too weak to split on, but
// strong enough to notice a dialect mboxEnvelope does not know — the case
// where a whole file collapses into a single message.
var mboxEnvelopeLoose = regexp.MustCompile(`(?m)^From \S+ +[A-Za-z]{3} +[A-Za-z]{3} +\d{1,2} +\d{1,2}:\d{2}`)

// looksUnsplit reports whether raw, the only message a file produced, still
// carries an envelope line below its own. Reporting a merged file as "1 new"
// is the worst outcome the splitter has, so importers say so out loud.
func looksUnsplit(raw []byte) bool {
	if i := bytes.IndexByte(raw, '\n'); i >= 0 {
		raw = raw[i+1:]
	}
	return mboxEnvelopeLoose.Match(raw)
}

// SplitMbox streams messages out of an mbox file (mboxrd quoting, as written
// by Gmail Takeout), calling fn with each raw RFC 822 message.
func SplitMbox(r io.Reader, fn func(raw []byte) error) error {
	br := bufio.NewReaderSize(r, 1<<20)
	var cur bytes.Buffer
	flush := func() error {
		if cur.Len() == 0 {
			return nil
		}
		raw := make([]byte, cur.Len())
		copy(raw, cur.Bytes())
		cur.Reset()
		return fn(raw)
	}
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			switch {
			case mboxEnvelope.Match(line):
				if err := flush(); err != nil {
					return err
				}
			case bytes.HasPrefix(line, []byte(">")) && bytes.HasPrefix(bytes.TrimLeft(line, ">"), []byte("From ")):
				cur.Write(line[1:]) // mboxrd: strip one level of > quoting
			default:
				cur.Write(line)
			}
		}
		if err == io.EOF {
			return flush()
		}
		if err != nil {
			return err
		}
	}
}

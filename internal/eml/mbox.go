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
// the numeric zone Gmail Takeout inserts before the year.
//
// Recognising the envelope by shape rather than by "the previous line was
// blank" is what lets a message whose body ends without a trailing newline be
// followed by another message, while ordinary unquoted body text starting with
// "From " (mboxo producers do not quote it) stays part of the body.
var mboxEnvelope = regexp.MustCompile(
	`^From \S+ +[A-Za-z]{3} +[A-Za-z]{3} +\d{1,2} +\d{1,2}:\d{2}(:\d{2})?( +[+-]\d{4})? +\d{4}`)

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

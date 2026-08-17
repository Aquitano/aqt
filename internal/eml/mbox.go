package eml

import (
	"bufio"
	"bytes"
	"io"
)

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
	// A "From " line is only a message separator at the start of the file or
	// after a blank line; unquoted "From " body text (mboxo producers like
	// Thunderbird) must not split the message.
	prevBlank := true
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			switch {
			case prevBlank && bytes.HasPrefix(line, []byte("From ")):
				if err := flush(); err != nil {
					return err
				}
			case bytes.HasPrefix(line, []byte(">")) && bytes.HasPrefix(bytes.TrimLeft(line, ">"), []byte("From ")):
				cur.Write(line[1:]) // mboxrd: strip one level of > quoting
			default:
				cur.Write(line)
			}
			prevBlank = len(bytes.TrimRight(line, "\r\n")) == 0
		}
		if err == io.EOF {
			return flush()
		}
		if err != nil {
			return err
		}
	}
}

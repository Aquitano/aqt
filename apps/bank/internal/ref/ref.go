// Package ref is the one written form of every record that can be cited:
// kind:value, such as msg:3f9a0c2e5b7d1a46. Values are lowercase hex; an
// uppercase one is rejected rather than folded, so each record has exactly
// one spelling.
package ref

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/content"
)

type Kind string

const (
	KindMessage    Kind = "msg"
	KindContent    Kind = "content"
	KindItem       Kind = "item"
	KindActivity   Kind = "activity"
	KindCollection Kind = "collection"
	KindFile       Kind = "file"
	KindPage       Kind = "page"
)

// A content ref is any prefix of the BLAKE3 digest from 16 characters up to
// the whole 64; a longer one tells apart contents that share a shorter one.
var valueChars = map[Kind]struct{ min, max int }{
	KindMessage:    {16, 16},
	KindContent:    {16, 64},
	KindItem:       {32, 32},
	KindActivity:   {32, 32},
	KindCollection: {32, 32},
	KindFile:       {32, 32},
	KindPage:       {32, 32},
}

const grammar = "a ref is kind:value in lowercase hex: msg:<16 hex>, content:<16 to 64 hex>, " +
	"or item:, activity:, collection:, file: or page: with 32 hex"

type Ref struct {
	kind  Kind
	value string
}

func Parse(s string) (Ref, error) {
	kind, value, ok := strings.Cut(s, ":")
	if !ok {
		return Ref{}, fmt.Errorf("%q is not a ref: %s", s, grammar)
	}
	chars, known := valueChars[Kind(kind)]
	if !known {
		return Ref{}, fmt.Errorf("%q is not a ref: unknown kind %q; %s", s, kind, grammar)
	}
	if len(value) < chars.min || len(value) > chars.max || !lowerHex(value) {
		return Ref{}, fmt.Errorf("%q is not a ref: %s", s, grammar)
	}
	return Ref{kind: Kind(kind), value: value}, nil
}

func lowerHex(s string) bool {
	for _, r := range s {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

func (r Ref) Kind() Kind { return r.kind }

func (r Ref) String() string { return string(r.kind) + ":" + r.value }

// UnmarshalText lets HTTP parameters and CLI arguments decode straight into
// a ref, so a malformed one is refused where it enters.
func (r *Ref) UnmarshalText(text []byte) (err error) {
	*r, err = Parse(string(text))
	return err
}

// Message is a ref known to name a message.
type Message struct{ value string }

func ParseMessage(s string) (Message, error) {
	r, err := Parse(s)
	if err != nil {
		return Message{}, err
	}
	return r.Message()
}

func (r Ref) Message() (Message, error) {
	if r.kind != KindMessage {
		return Message{}, fmt.Errorf("%s is not a message ref: a message ref is msg:<16 hex>", r)
	}
	return Message{value: r.value}, nil
}

// ForMessage derives a message's ref from its source and the identifier that
// keys it: the RFC 822 Message-ID where there is one, the source's external id
// otherwise. Which of the two was used is hashed too, so an external id that
// spells some other mail's Message-ID cannot share its ref.
func ForMessage(source, messageID, externalID string) Message {
	field, value := "external_id", externalID
	if messageID != "" {
		field, value = "message_id", messageID
	}
	sum := sha256.Sum256([]byte(source + "\x00" + field + "\x00" + value))
	return Message{value: hex.EncodeToString(sum[:])[:valueChars[KindMessage].max]}
}

func (m Message) IsZero() bool { return m.value == "" }

func (m Message) String() string { return Ref{kind: KindMessage, value: m.value}.String() }

func (m *Message) UnmarshalText(text []byte) (err error) {
	*m, err = ParseMessage(string(text))
	return err
}

// Content is a ref known to name bytes.
type Content struct{ value string }

func ParseContent(s string) (Content, error) {
	r, err := Parse(s)
	if err != nil {
		return Content{}, err
	}
	return r.Content()
}

func (r Ref) Content() (Content, error) {
	if r.kind != KindContent {
		return Content{}, fmt.Errorf("%s is not a content ref: a content ref is content:<16 to 64 hex>", r)
	}
	return Content{value: r.value}, nil
}

// ForContent is the whole digest as a ref, the form no other content shares.
func ForContent(d content.Digest) Content { return Content{value: d.String()} }

// Hex is the digest prefix the ref names.
func (c Content) Hex() string { return c.value }

func (c Content) IsZero() bool { return c.value == "" }

func (c Content) String() string { return Ref{kind: KindContent, value: c.value}.String() }

func (c Content) MarshalText() ([]byte, error) { return []byte(c.String()), nil }

func (c *Content) UnmarshalText(text []byte) (err error) {
	*c, err = ParseContent(string(text))
	return err
}

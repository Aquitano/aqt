package blob

import (
	"bytes"
	"strings"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	html := []byte("<html><body>" + strings.Repeat("<p>hello world</p>", 2000) + "</body></html>")
	payload := Compress(html)
	if len(payload) >= len(html) {
		t.Errorf("compressed %d bytes to %d, expected a smaller payload", len(html), len(payload))
	}
	got, err := Decompress(payload)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, html) {
		t.Error("decompressed bytes differ from the input")
	}
	if Hash(got) != Hash(html) {
		t.Error("hash changed across the round trip")
	}
}

package urlnorm

import (
	"errors"
	"testing"
)

func TestNormalize(t *testing.T) {
	cases := []struct {
		name, raw, want, host string
	}{
		{"youtube video id survives, si dropped",
			"https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc123",
			"https://www.youtube.com/watch?v=dQw4w9WgXcQ", "www.youtube.com"},
		{"utm tags collapse, keys sorted, default port and fragment dropped",
			"HTTPS://Example.COM:443/Post?utm_source=nl&utm_medium=mail&b=2&a=1&fbclid=x#section",
			"https://example.com/Post?a=1&b=2", "example.com"},
		{"bare host gets a root path",
			"https://example.com", "https://example.com/", "example.com"},
		{"non-default port kept, credentials dropped",
			"http://user:pw@localhost:8080/x", "http://localhost:8080/x", "localhost"},
		{"http default port dropped",
			"http://example.com:80/", "http://example.com/", "example.com"},
		{"a query with a semicolon is kept whole",
			"https://fonts.googleapis.com/css2?family=Roboto:wght@400;700",
			"https://fonts.googleapis.com/css2?family=Roboto:wght@400;700", "fonts.googleapis.com"},
		{"a query with a stray percent is kept whole",
			"https://example.com/p?id=100%", "https://example.com/p?id=100%", "example.com"},
		{"ipv6 host keeps its brackets",
			"http://[::1]:8080/x", "http://[::1]:8080/x", "::1"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, host, err := Normalize(c.raw)
			if err != nil {
				t.Fatal(err)
			}
			if got != c.want || host != c.host {
				t.Errorf("Normalize(%q) = %q, %q; want %q, %q", c.raw, got, host, c.want, c.host)
			}
		})
	}
	for _, raw := range []string{"chrome://extensions", "/relative/path", "mailto:a@b.c", ""} {
		if _, _, err := Normalize(raw); !errors.Is(err, ErrNotHTTP) {
			t.Errorf("Normalize(%q) err = %v, want ErrNotHTTP", raw, err)
		}
	}
}

package store

import (
	"strings"
	"testing"
)

func TestCutSnippetCentresOnTheFirstQueryTerm(t *testing.T) {
	text := "Bun is a SQL-first Golang ORM for PostgreSQL, MySQL, MSSQL and SQLite. It keeps the SQL visible."
	if got := cutSnippet(text, "postgresql orm", 40); !strings.Contains(got, "ORM for PostgreSQL") {
		t.Fatalf("snippet = %q", got)
	}
	if got := cutSnippet(text, "nothing here", 20); got != "Bun is a SQL-first G" {
		t.Fatalf("fallback snippet = %q", got)
	}
}

func TestCutSnippetFindsTheTermAfterTextLowercasingResizes(t *testing.T) {
	for _, before := range []string{strings.Repeat("Ⱥ", 100), strings.Repeat("İ", 200)} {
		if got := cutSnippet(before+" Needle in a haystack", "needle", 160); !strings.Contains(got, "Needle") {
			t.Errorf("snippet = %q", got)
		}
	}
}

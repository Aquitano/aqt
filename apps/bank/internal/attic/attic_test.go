package attic_test

import (
	"errors"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/attic"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestCatalogueSearchesAndResolves(t *testing.T) {
	st, _ := storetest.NewCatalogue(t)
	catalogue := attic.New(st)
	if _, err := catalogue.SearchDisks(t.Context(), store.SearchOptions{Query: "report", Limit: 5}); err != nil {
		t.Fatal(err)
	}
	if _, err := catalogue.ModifiedFiles(t.Context(), time.Unix(0, 0), time.Now(), 5); err != nil {
		t.Fatal(err)
	}
	absent, err := ref.ParseContent("content:0000000000000000")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := catalogue.Content(t.Context(), absent); !errors.Is(err, attic.ErrNotFound) {
		t.Fatalf("a ref no content has: %v", err)
	}
}

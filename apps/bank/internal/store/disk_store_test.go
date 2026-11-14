package store_test

import (
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/aquitano/aqt/apps/bank/internal/db"
	"github.com/aquitano/aqt/apps/bank/internal/disks/disk"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/search"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestReadOnlyStoreReadsButCannotWrite(t *testing.T) {
	_, dsn := storetest.NewNamed(t)
	pool, err := db.OpenReadOnly(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	st := store.New(pool)
	if _, err := st.KnownVolumes(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Search(t.Context(), store.SearchOptions{Query: "report", Limit: 5}); err != nil {
		t.Fatalf("name search on a read-only store: %v", err)
	}
	if _, err := st.SearchDiskTexts(t.Context(), store.SearchOptions{Query: "report", Limit: 5}); err != nil {
		t.Fatalf("text search on a read-only store: %v", err)
	}
	_, err = st.ResolveVolume(t.Context(), disk.Volume{Label: "Data"}, "", true)
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); !ok || pgErr.Code != "25006" {
		t.Fatalf("write on a read-only store: %v", err)
	}
}

func TestCatalogueSearchesAndResolves(t *testing.T) {
	st := storetest.New(t)
	q, err := search.Parse("report", search.All)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.RankEntries(t.Context(), q, 5); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Modified(t.Context(), time.Unix(0, 0), time.Now(), 5); err != nil {
		t.Fatal(err)
	}
	absent, err := ref.ParseContent("content:0000000000000000")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Content(t.Context(), absent); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a ref no content has: %v", err)
	}
}

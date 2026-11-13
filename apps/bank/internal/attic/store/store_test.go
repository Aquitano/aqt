package store_test

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/aquitano/aqt/apps/bank/internal/attic/disk"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/db"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestReadOnlyStoreReadsButCannotWrite(t *testing.T) {
	_, dsn := storetest.NewCatalogue(t)
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
	if _, err := st.SearchTexts(t.Context(), store.SearchOptions{Query: "report", Limit: 5}); err != nil {
		t.Fatalf("text search on a read-only store: %v", err)
	}
	_, err = st.ResolveVolume(t.Context(), disk.Volume{Label: "Data"}, "", true)
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); !ok || pgErr.Code != "25006" {
		t.Fatalf("write on a read-only store: %v", err)
	}
}

package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/aquitano/aqt/apps/tracker/internal/store"
	"github.com/aquitano/aqt/apps/tracker/internal/storetest"
	"github.com/aquitano/aqt/apps/tracker/internal/urlnorm"
)

func TestResentPageViewUpdatesTitleButNeverClearsIt(t *testing.T) {
	st, dsn := storetest.NewNamed(t)
	ctx := context.Background()
	normalized, host, err := urlnorm.Normalize("https://github.com/uptrace/bun")
	if err != nil {
		t.Fatal(err)
	}
	key := store.URLKey{Hash: urlnorm.Hash(normalized), Normalized: normalized, Host: host}
	device, id := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	send := func(title string) {
		t.Helper()
		_, err := st.ApplyEvents(ctx, device, store.Events{PageViews: []store.PageViewEvent{
			{ID: id, URL: key, Title: title, StartedAt: time.Now(), NavigationType: "load"}}})
		if err != nil {
			t.Fatal(err)
		}
	}
	titled := func() int64 {
		return storetest.QueryInt(t, dsn,
			"select count(*) from page_views where id = $1 and title = $2", id, "uptrace/bun: SQL-first Golang ORM")
	}
	send("")
	send("uptrace/bun: SQL-first Golang ORM")
	if titled() != 1 {
		t.Fatal("resent page view did not pick up its title")
	}
	send("")
	if titled() != 1 {
		t.Fatal("empty resend cleared the title")
	}
}

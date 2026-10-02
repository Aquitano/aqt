package store_test

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/aquitano/aqt/apps/tracker/internal/blob"
	"github.com/aquitano/aqt/apps/tracker/internal/store"
	"github.com/aquitano/aqt/apps/tracker/internal/storetest"
	"github.com/aquitano/aqt/apps/tracker/internal/urlnorm"
)

func TestLatestCaptureHashPicksThePagesNewestCapture(t *testing.T) {
	st := storetest.New(t)
	ctx := context.Background()
	key := func(raw string) store.URLKey {
		t.Helper()
		normalized, host, err := urlnorm.Normalize(raw)
		if err != nil {
			t.Fatal(err)
		}
		return store.URLKey{Hash: urlnorm.Hash(normalized), Normalized: normalized, Host: host}
	}
	page := key("https://x.com/aquitano/status/1")
	device := uuid.Must(uuid.NewV7())
	capture := func(html string, at time.Time) []byte {
		t.Helper()
		pv := uuid.Must(uuid.NewV7())
		if _, err := st.ApplyEvents(ctx, device, store.Events{PageViews: []store.PageViewEvent{
			{ID: pv, URL: page, StartedAt: at, NavigationType: "load"}}}); err != nil {
			t.Fatal(err)
		}
		hash := blob.Hash([]byte(html))
		payload := blob.Compress([]byte(html))
		if _, err := st.InsertCapture(ctx, store.CaptureInput{
			Capture: store.Capture{ID: uuid.Must(uuid.NewV7()), PageViewID: pv, DeviceID: device, RawHash: hash[:],
				Extractor: "x", CapturedAt: at, Reason: "initial", URL: page.Normalized},
			URL:     page,
			Blob:    store.RawHTMLBlob{Hash: hash[:], Codec: blob.CodecZstd, RawBytes: len(html), StoredBytes: len(payload), Payload: payload},
			Version: 1,
		}); err != nil {
			t.Fatal(err)
		}
		return hash[:]
	}
	now := time.Now()
	newer := capture("<p>with replies</p>", now)
	capture("<p>first</p>", now.Add(-time.Hour))

	got, err := st.LatestCaptureHash(ctx, key("https://x.com/aquitano/status/1?utm_source=share").Hash)
	if err != nil || !bytes.Equal(got, newer) {
		t.Errorf("latest capture = %x (%v), want %x", got, err, newer)
	}
	if _, err := st.LatestCaptureHash(ctx, key("https://x.com/aquitano/status/2").Hash); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("uncaptured page: err = %v, want ErrNotFound", err)
	}
}

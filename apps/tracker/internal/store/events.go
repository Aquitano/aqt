package store

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/uptrace/bun"
)

const (
	EventPageView      = "page_view"
	EventSpanStart     = "span_start"
	EventSpanHeartbeat = "span_heartbeat"
	EventSpanEnd       = "span_end"
)

type PageViewEvent struct {
	ID             uuid.UUID
	URL            URLKey
	Referrer       *URLKey
	Title          string
	StartedAt      time.Time
	NavigationType string
	TabSessionID   string
	Private        bool
}

// SpanStartEvent carries exactly one identity: PageViewID for a browser span,
// AppName for a desktop one.
type SpanStartEvent struct {
	ID          uuid.UUID
	PageViewID  uuid.UUID
	AppName     string
	BundleID    string
	WindowTitle string
	StartedAt   time.Time
}

type SpanHeartbeatEvent struct {
	ID uuid.UUID
	At time.Time
}

type SpanEndEvent struct {
	ID      uuid.UUID
	EndedAt time.Time
	Reason  string
}

type Events struct {
	PageViews  []PageViewEvent
	SpanStarts []SpanStartEvent
	Heartbeats []SpanHeartbeatEvent
	SpanEnds   []SpanEndEvent
}

// EventResult counts per event type, so the caller can label its metrics.
type EventResult struct {
	Accepted map[string]int
	Dropped  map[string]int
}

func newEventResult() EventResult {
	return EventResult{Accepted: map[string]int{}, Dropped: map[string]int{}}
}

// ApplyEvents stores one batch in a single transaction. Page views go first,
// then span starts, heartbeats and ends, so an event order that was scrambled
// on the way here still resolves. Every write is idempotent; a browser span
// whose page view is unknown is dropped and counted.
func (s *Store) ApplyEvents(ctx context.Context, deviceID uuid.UUID, ev Events) (EventResult, error) {
	res := newEventResult()
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		for _, pv := range ev.PageViews {
			urlID, err := upsertURL(ctx, tx, pv.URL)
			if err != nil {
				return err
			}
			var refID int64
			if pv.Referrer != nil {
				if refID, err = upsertURL(ctx, tx, *pv.Referrer); err != nil {
					return err
				}
			}
			row := PageView{ID: pv.ID, DeviceID: deviceID, URLID: urlID, TabSessionID: pv.TabSessionID,
				Title: pv.Title, StartedAt: pv.StartedAt, NavigationType: pv.NavigationType,
				ReferrerURLID: refID, Private: pv.Private}
			if _, err := tx.NewInsert().Model(&row).
				On("conflict (id) do update set title = excluded.title").
				Where("excluded.title is not null").Exec(ctx); err != nil {
				return err
			}
			res.Accepted[EventPageView]++
		}
		known, err := knownPageViews(ctx, tx, ev.SpanStarts)
		if err != nil {
			return err
		}
		for _, sp := range ev.SpanStarts {
			row := ActivitySpan{ID: sp.ID, DeviceID: deviceID, StartedAt: sp.StartedAt, EndedAt: sp.StartedAt,
				AppName: sp.AppName, BundleID: sp.BundleID, WindowTitle: sp.WindowTitle}
			if sp.PageViewID != uuid.Nil {
				if !known[sp.PageViewID] {
					res.Dropped[EventSpanStart]++
					continue
				}
				row.PageViewID = uuid.NullUUID{UUID: sp.PageViewID, Valid: true}
			}
			if _, err := tx.NewInsert().Model(&row).On("conflict (id) do nothing").Exec(ctx); err != nil {
				return err
			}
			res.Accepted[EventSpanStart]++
		}
		for _, hb := range ev.Heartbeats {
			r, err := tx.NewUpdate().Model((*ActivitySpan)(nil)).
				Set("ended_at = greatest(ended_at, ?)", hb.At).Where("id = ?", hb.ID).Exec(ctx)
			if err != nil {
				return err
			}
			count(&res, EventSpanHeartbeat, r)
		}
		for _, end := range ev.SpanEnds {
			r, err := tx.NewUpdate().Model((*ActivitySpan)(nil)).
				Set("ended_at = greatest(ended_at, ?)", end.EndedAt).
				Set("end_reason = coalesce(end_reason, ?)", end.Reason).
				Where("id = ?", end.ID).Exec(ctx)
			if err != nil {
				return err
			}
			count(&res, EventSpanEnd, r)
		}
		return nil
	})
	if err != nil {
		return EventResult{}, err
	}
	return res, nil
}

func knownPageViews(ctx context.Context, tx bun.Tx, starts []SpanStartEvent) (map[uuid.UUID]bool, error) {
	known := map[uuid.UUID]bool{}
	if len(starts) == 0 {
		return known, nil
	}
	ids := make([]uuid.UUID, 0, len(starts))
	for _, sp := range starts {
		if sp.PageViewID != uuid.Nil {
			ids = append(ids, sp.PageViewID)
		}
	}
	if len(ids) == 0 {
		return known, nil
	}
	var found []uuid.UUID
	if err := tx.NewSelect().Model((*PageView)(nil)).Column("id").
		Where("id in (?)", bun.List(ids)).Scan(ctx, &found); err != nil {
		return nil, err
	}
	for _, id := range found {
		known[id] = true
	}
	return known, nil
}

func count(res *EventResult, typ string, r interface{ RowsAffected() (int64, error) }) {
	if n, _ := r.RowsAffected(); n > 0 {
		res.Accepted[typ]++
	} else {
		res.Dropped[typ]++
	}
}

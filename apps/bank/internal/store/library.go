package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/jackc/pgx/v5"
)

func libraryID(kind string, identity library.Identity, supplied string) (string, error) {
	id := library.StableID(kind, identity)
	if supplied != "" && supplied != id {
		return "", fmt.Errorf("%s id does not match its source identity: %w", kind, library.ErrInvalid)
	}
	return id, nil
}

// libraryDate is d as it is stored and read back: an instant in UTC to the
// microsecond, which is what Postgres keeps.
func libraryDate(d library.Date) library.Date {
	switch d.Precision {
	case "":
		d.Precision = "unknown"
	case "instant":
		if at, err := time.Parse(time.RFC3339Nano, d.Value); err == nil {
			d.Value = at.UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)
		}
	}
	return d
}

// dateColumns are a date's timestamp and precision columns. A day is its UTC
// midnight.
func dateColumns(d library.Date) (*time.Time, string, error) {
	d = libraryDate(d)
	layout := time.RFC3339Nano
	switch d.Precision {
	case "unknown":
		return nil, d.Precision, nil
	case "day":
		layout = time.DateOnly
	}
	at, err := time.Parse(layout, d.Value)
	if err != nil {
		return nil, "", fmt.Errorf("invalid %s date %q: %w", d.Precision, d.Value, library.ErrInvalid)
	}
	return &at, d.Precision, nil
}
func libraryStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func (s *Store) ImportLibrary(ctx context.Context, batch library.ImportBatch) (library.ImportResult, error) {
	if err := batch.Validate(); err != nil {
		return library.ImportResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return library.ImportResult{}, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	result, err := importLibrary(ctx, tx, batch)
	if err != nil {
		return library.ImportResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return library.ImportResult{}, err
	}
	return result, nil
}

func importLibrary(ctx context.Context, tx pgx.Tx, b library.ImportBatch) (library.ImportResult, error) {
	var r library.ImportResult
	for _, v := range b.Items {
		id, err := libraryID("item", v.Identity, v.ID)
		if err != nil {
			return r, err
		}
		var inserted bool
		err = tx.QueryRow(ctx, `insert into library_items(id,source,account,external_id,kind,title,description,url,provider,provider_id,creators,series,album,year,season,episode,duration_seconds,provenance)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
   on conflict(id) do update set kind=excluded.kind,title=case when excluded.provider_id<>'' and excluded.title=excluded.provider_id and library_items.title<>library_items.provider_id then library_items.title else excluded.title end,
   description=coalesce(nullif(excluded.description,''),library_items.description),url=coalesce(nullif(excluded.url,''),library_items.url),
   provider=coalesce(nullif(excluded.provider,''),library_items.provider),provider_id=coalesce(nullif(excluded.provider_id,''),library_items.provider_id),
   creators=case when cardinality(excluded.creators)>0 then excluded.creators else library_items.creators end,
   series=coalesce(nullif(excluded.series,''),library_items.series),album=coalesce(nullif(excluded.album,''),library_items.album),
   year=coalesce(excluded.year,library_items.year),season=coalesce(excluded.season,library_items.season),episode=coalesce(excluded.episode,library_items.episode),
   duration_seconds=coalesce(excluded.duration_seconds,library_items.duration_seconds),provenance=case when coalesce((excluded.provenance->>'raw_input')::bigint,0)<>0 then excluded.provenance else library_items.provenance end returning xmax=0`,
			id, v.Source, v.Account, v.ExternalID, v.Kind, v.Title, v.Description, v.URL, v.Provider, v.ProviderID, libraryStrings(v.Creators), v.Series, v.Album, v.Year, v.Season, v.Episode, v.DurationSeconds, v.Provenance).Scan(&inserted)
		if err != nil {
			return r, err
		}
		if inserted {
			r.Items++
		} else {
			r.Duplicates++
		}
	}
	if len(b.Items) > 0 {
		itemIDs, rawInputs, locators := []string{}, []int64{}, []string{}
		for _, item := range b.Items {
			evidence := append([]library.Provenance{item.Provenance}, item.Evidence...)
			for _, reference := range evidence {
				if reference.RawInput == 0 {
					continue
				}
				itemIDs = append(itemIDs, library.StableID("item", item.Identity))
				rawInputs = append(rawInputs, reference.RawInput)
				locators = append(locators, reference.Locator)
			}
		}
		if len(itemIDs) > 0 {
			if _, err := tx.Exec(ctx, `insert into library_item_evidence(item_id,raw_input_id,locator) select unnest($1::text[]),unnest($2::bigint[]),unnest($3::text[]) on conflict do nothing`, itemIDs, rawInputs, locators); err != nil {
				return r, err
			}
		}
	}
	for _, v := range b.Activity {
		id, err := libraryID("activity", v.Identity, v.ID)
		if err != nil {
			return r, err
		}
		at, precision, err := dateColumns(v.Occurred)
		if err != nil {
			return r, err
		}
		tag, err := tx.Exec(ctx, `insert into library_activity(id,source,account,external_id,item_id,kind,title,occurred_at,occurred_precision,duration_seconds,provenance)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict(id) do nothing`, id, v.Source, v.Account, v.ExternalID, v.ItemID, v.Kind, v.Title, at, precision, v.DurationSeconds, v.Provenance)
		if err != nil {
			return r, err
		}
		if tag.RowsAffected() == 0 {
			var raw []byte
			var youtubeWatch bool
			if err = tx.QueryRow(ctx, `select (to_jsonb(a)-'occurred_at'-'occurred_precision') || jsonb_build_object('occurred',bank_library_date(a.occurred_at,a.occurred_precision)),a.kind='watch' and a.external_id ~ '^[0-9a-f]{64}$' and exists(select 1 from library_items i where i.id=a.item_id and i.source=a.source and i.account=a.account and i.kind='video' and ((i.provider='youtube' and i.external_id='video:' || i.provider_id) or (i.provider='' and i.external_id ~ '^unavailable-title:[0-9a-f]{64}$'))) from library_activity a where id=$1 for update`, id).Scan(&raw, &youtubeWatch); err != nil {
				return r, err
			}
			var existing library.Activity
			if err = json.Unmarshal(raw, &existing); err != nil {
				return r, err
			}
			occurred, compatible := reconcileActivityDate(existing.Occurred, libraryDate(v.Occurred), youtubeWatch)
			if existing.ItemID != v.ItemID || existing.Kind != v.Kind || !compatible || !sameLibraryNumber(existing.DurationSeconds, v.DurationSeconds) {
				return r, fmt.Errorf("activity identity already refers to different observation: %w", library.ErrConflict)
			}
			if occurred != existing.Occurred {
				at, precision, err := dateColumns(occurred)
				if err != nil {
					return r, err
				}
				if _, err = tx.Exec(ctx, `update library_activity set occurred_at=$2,occurred_precision=$3 where id=$1`, id, at, precision); err != nil {
					return r, err
				}
			}
			r.Duplicates++
		}
		for _, reference := range append([]library.Provenance{v.Provenance}, v.Evidence...) {
			if reference.RawInput == 0 {
				continue
			}
			if _, err = tx.Exec(ctx, `insert into library_activity_evidence(activity_id,raw_input_id,locator) values($1,$2,$3) on conflict do nothing`, id, reference.RawInput, reference.Locator); err != nil {
				return r, err
			}
		}
		r.Activity += int(tag.RowsAffected())
	}
	for _, v := range b.Collections {
		id, err := libraryID("collection", v.Identity, v.ID)
		if err != nil {
			return r, err
		}
		var inserted bool
		err = tx.QueryRow(ctx, `insert into library_collections(id,source,account,external_id,kind,title,description) values($1,$2,$3,$4,$5,$6,$7)
   on conflict(id) do update set title=excluded.title,description=excluded.description,kind=excluded.kind where not library_collections.personal returning xmax=0`, id, v.Source, v.Account, v.ExternalID, v.Kind, v.Title, v.Description).Scan(&inserted)
		if errors.Is(err, pgx.ErrNoRows) {
			return r, library.ErrConflict
		}
		if err != nil {
			return r, err
		}
		if inserted {
			r.Collections++
		} else {
			r.Duplicates++
		}
		if v.Snapshot != nil {
			if _, err := insertLibrarySnapshot(ctx, tx, id, *v.Snapshot); err != nil {
				return r, err
			}
		}
	}
	var fileContents []int64
	for _, v := range b.Files {
		id, err := libraryID("file", v.Identity, v.ID)
		if err != nil {
			return r, err
		}
		contentID, err := upsertContent(ctx, tx, v.BLAKE3, v.SizeBytes)
		if err != nil {
			return r, err
		}
		var inserted bool
		err = tx.QueryRow(ctx, `insert into library_files(id,source,account,external_id,content_id,filename,mime_type,provenance) values($1,$2,$3,$4,$5,$6,$7,$8)
   on conflict(id) do update set filename=excluded.filename,mime_type=excluded.mime_type,provenance=excluded.provenance where library_files.content_id=excluded.content_id returning xmax=0`, id, v.Source, v.Account, v.ExternalID, contentID, v.Filename, v.MimeType, v.Provenance).Scan(&inserted)
		if errors.Is(err, pgx.ErrNoRows) {
			return r, fmt.Errorf("file identity already refers to different bytes: %w", library.ErrConflict)
		}
		if err != nil {
			return r, err
		}
		if inserted {
			r.Files++
			fileContents = append(fileContents, contentID)
		} else {
			r.Duplicates++
		}
		for _, itemID := range v.ItemIDs {
			if _, err := tx.Exec(ctx, `insert into library_item_files(item_id,file_id) values($1,$2) on conflict do nothing`, itemID, id); err != nil {
				return r, err
			}
		}
	}
	if err := queueText(ctx, tx, fileContents); err != nil {
		return r, err
	}
	for _, v := range b.Items {
		for _, fileID := range v.FileIDs {
			if _, err := tx.Exec(ctx, `insert into library_item_files(item_id,file_id) values($1,$2) on conflict do nothing`, library.StableID("item", v.Identity), fileID); err != nil {
				return r, err
			}
		}
	}
	for _, v := range b.Pages {
		id, err := libraryID("page", v.Identity, v.ID)
		if err != nil {
			return r, err
		}
		var inserted bool
		err = tx.QueryRow(ctx, `insert into library_pages(id,source,account,external_id,path,title,body,answers,tags,aliases,content_hash,revision,sensitivity,provenance) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
   on conflict(id) do update set path=excluded.path,title=excluded.title,body=excluded.body,answers=excluded.answers,tags=excluded.tags,aliases=excluded.aliases,content_hash=excluded.content_hash,revision=excluded.revision,sensitivity=excluded.sensitivity,provenance=excluded.provenance returning xmax=0`, id, v.Source, v.Account, v.ExternalID, v.Path, v.Title, v.Body, libraryStrings(v.Answers), libraryStrings(v.Tags), libraryStrings(v.Aliases), v.ContentHash, v.Revision, v.Sensitivity, v.Provenance).Scan(&inserted)
		if err != nil {
			return r, err
		}
		if inserted {
			r.Pages++
		} else {
			r.Duplicates++
		}
	}
	return r, nil
}

func insertLibrarySnapshot(ctx context.Context, tx pgx.Tx, collectionID string, snapshot library.Snapshot) (int64, error) {
	snapshot.Captured = libraryDate(snapshot.Captured)
	if snapshot.Entries == nil {
		snapshot.Entries = []library.Entry{}
	}
	for i := range snapshot.Entries {
		snapshot.Entries[i].Added = libraryDate(snapshot.Entries[i].Added)
	}
	capturedAt, capturedPrecision, err := dateColumns(snapshot.Captured)
	if err != nil {
		return 0, err
	}
	var id int64
	err = tx.QueryRow(ctx, `insert into library_snapshots(collection_id,external_id,captured_at,captured_precision,completeness,provenance) values($1,$2,$3,$4,$5,$6) on conflict(collection_id,external_id) do nothing returning id`, collectionID, snapshot.ExternalID, capturedAt, capturedPrecision, snapshot.Completeness, snapshot.Provenance).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		var raw []byte
		err = tx.QueryRow(ctx, `select s.id,`+librarySnapshotJSON+` from library_snapshots s where collection_id=$1 and external_id=$2`, collectionID, snapshot.ExternalID).Scan(&id, &raw)
		if err != nil {
			return 0, err
		}
		var existing library.Snapshot
		if err = json.Unmarshal(raw, &existing); err != nil {
			return 0, err
		}
		if !sameSnapshot(existing, snapshot) {
			return 0, fmt.Errorf("snapshot identity already refers to different content: %w", library.ErrConflict)
		}
		return id, nil
	}
	if err != nil {
		return 0, err
	}
	for _, entry := range snapshot.Entries {
		addedAt, addedPrecision, err := dateColumns(entry.Added)
		if err != nil {
			return 0, err
		}
		if _, err = tx.Exec(ctx, `insert into library_entries(snapshot_id,position,item_id,external_id,added_at,added_precision) values($1,$2,$3,$4,$5,$6)`, id, entry.Position, entry.ItemID, entry.ExternalID, addedAt, addedPrecision); err != nil {
			return 0, err
		}
	}
	return id, nil
}

func sameSnapshot(a, b library.Snapshot) bool {
	// Entry positions carry order independently of the input array order.
	am := map[int]library.Entry{}
	for _, e := range a.Entries {
		am[e.Position] = e
	}
	if a.ExternalID != b.ExternalID || a.Captured != b.Captured || a.Completeness != b.Completeness || len(a.Entries) != len(b.Entries) {
		return false
	}
	for _, e := range b.Entries {
		if other, ok := am[e.Position]; !ok || other != e {
			return false
		}
	}
	return true
}

func (s *Store) PublishLibraryPages(ctx context.Context, source, account string, pages []library.Page) (library.ImportResult, error) {
	if source == "" {
		return library.ImportResult{}, fmt.Errorf("publication source required")
	}
	for _, p := range pages {
		if p.Source != source || p.Account != account {
			return library.ImportResult{}, fmt.Errorf("page lies outside publication source/account")
		}
	}
	batch := library.ImportBatch{Version: 1, Pages: pages}
	if err := batch.Validate(); err != nil {
		return library.ImportResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return library.ImportResult{}, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err = tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1,0))`, library.StableID("publication", library.Identity{Source: source, Account: account})); err != nil {
		return library.ImportResult{}, err
	}
	result, err := importLibrary(ctx, tx, batch)
	if err != nil {
		return library.ImportResult{}, err
	}
	ids := []string{}
	for _, p := range pages {
		ids = append(ids, library.StableID("page", p.Identity))
	}
	if _, err = tx.Exec(ctx, `delete from library_pages where source=$1 and account=$2 and not(id=any($3))`, source, account, ids); err != nil {
		return library.ImportResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return library.ImportResult{}, err
	}
	return result, nil
}

func sameLibraryNumber(a, b *int) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func reconcileActivityDate(existing, incoming library.Date, allowPrecision bool) (library.Date, bool) {
	if existing == incoming {
		return existing, true
	}
	if existing.Precision != "instant" || incoming.Precision != "instant" {
		return existing, false
	}
	a, err := time.Parse(time.RFC3339Nano, existing.Value)
	if err != nil {
		return existing, false
	}
	b, err := time.Parse(time.RFC3339Nano, incoming.Value)
	if err != nil {
		return existing, false
	}
	aDigits, bDigits := instantFractionDigits(existing.Value), instantFractionDigits(incoming.Value)
	resolution := time.Second
	for range min(aDigits, bDigits) {
		resolution /= 10
	}
	if !a.Equal(b) && (!allowPrecision || aDigits == bDigits || !a.Truncate(resolution).Equal(b.Truncate(resolution))) {
		return existing, false
	}
	if bDigits > aDigits {
		return incoming, true
	}
	return existing, true
}

func instantFractionDigits(value string) int {
	if len(value) <= 19 || (value[19] != '.' && value[19] != ',') {
		return 0
	}
	digits := 0
	for _, c := range value[20:] {
		if c < '0' || c > '9' {
			break
		}
		digits++
	}
	return min(digits, 9)
}

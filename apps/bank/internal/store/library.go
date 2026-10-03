package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/jackc/pgx/v5"
)

func libraryID(kind string, identity library.Identity, supplied string) (string, error) {
	id := library.StableID(kind, identity)
	if supplied != "" && supplied != id {
		return "", fmt.Errorf("%s id does not match its source identity", kind)
	}
	return id, nil
}

func libraryDate(d library.Date) library.Date {
	if d.Precision == "" {
		d.Precision = "unknown"
	}
	return d
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
	countLibraryImported(ctx, result, batch.Files)
	return result, nil
}

func countLibraryImported(ctx context.Context, r library.ImportResult, files []library.File) {
	countImported(ctx, r.Items+r.Activity+r.Collections+r.Pages, "")
	for _, f := range files {
		countImported(ctx, 0, f.SHA256)
	}
}

func importLibrary(ctx context.Context, tx pgx.Tx, b library.ImportBatch) (library.ImportResult, error) {
	var r library.ImportResult
	for _, v := range b.Items {
		id, err := libraryID("item", v.Identity, v.ID)
		if err != nil {
			return r, err
		}
		var inserted bool
		err = tx.QueryRow(ctx, `insert into library_items(id,source,account,external_id,kind,title,description,url,provider,provider_id,creators,series,album,year,season,episode,duration_seconds,provenance,search_text)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
   on conflict(id) do update set kind=excluded.kind,title=case when excluded.provider_id<>'' and excluded.title=excluded.provider_id and library_items.title<>library_items.provider_id then library_items.title else excluded.title end,
   description=coalesce(nullif(excluded.description,''),library_items.description),url=coalesce(nullif(excluded.url,''),library_items.url),
   provider=coalesce(nullif(excluded.provider,''),library_items.provider),provider_id=coalesce(nullif(excluded.provider_id,''),library_items.provider_id),
   creators=case when cardinality(excluded.creators)>0 then excluded.creators else library_items.creators end,
   series=coalesce(nullif(excluded.series,''),library_items.series),album=coalesce(nullif(excluded.album,''),library_items.album),
   year=coalesce(excluded.year,library_items.year),season=coalesce(excluded.season,library_items.season),episode=coalesce(excluded.episode,library_items.episode),
   duration_seconds=coalesce(excluded.duration_seconds,library_items.duration_seconds),provenance=case when coalesce(excluded.provenance->>'raw_ref','')<>'' then excluded.provenance else library_items.provenance end returning xmax=0`,
			id, v.Source, v.Account, v.ExternalID, v.Kind, v.Title, v.Description, v.URL, v.Provider, v.ProviderID, libraryStrings(v.Creators), v.Series, v.Album, v.Year, v.Season, v.Episode, v.DurationSeconds, v.Provenance, strings.Join([]string{v.Title, v.Description, strings.Join(v.Creators, " "), v.Series, v.Album, v.Provider, v.ProviderID}, " ")).Scan(&inserted)
		if err != nil {
			return r, err
		}
		if inserted {
			r.Items++
		}
	}
	if len(b.Items) > 0 {
		itemIDs, rawRefs, locators := []string{}, []string{}, []string{}
		for _, item := range b.Items {
			evidence := append([]library.Provenance{item.Provenance}, item.Evidence...)
			for _, reference := range evidence {
				if reference.RawRef == "" {
					continue
				}
				itemIDs = append(itemIDs, library.StableID("item", item.Identity))
				rawRefs = append(rawRefs, reference.RawRef)
				locators = append(locators, reference.Locator)
			}
		}
		if len(itemIDs) > 0 {
			if _, err := tx.Exec(ctx, `insert into library_item_evidence(item_id,raw_ref,locator) select unnest($1::text[]),unnest($2::text[]),unnest($3::text[]) on conflict do nothing`, itemIDs, rawRefs, locators); err != nil {
				return r, err
			}
		}
		ids := make([]string, 0, len(b.Items))
		for _, item := range b.Items {
			ids = append(ids, library.StableID("item", item.Identity))
		}
		if _, err := tx.Exec(ctx, `update library_items set search_text=title || ' ' || description || ' ' || array_to_string(creators,' ') || ' ' || series || ' ' || album || ' ' || provider || ' ' || provider_id where id=any($1)`, ids); err != nil {
			return r, err
		}
	}
	for _, v := range b.Activity {
		id, err := libraryID("activity", v.Identity, v.ID)
		if err != nil {
			return r, err
		}
		tag, err := tx.Exec(ctx, `insert into library_activity(id,source,account,external_id,item_id,kind,title,occurred,duration_seconds,provenance,search_text)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict(id) do nothing`, id, v.Source, v.Account, v.ExternalID, v.ItemID, v.Kind, v.Title, libraryDate(v.Occurred), v.DurationSeconds, v.Provenance, v.Title+" "+v.Kind)
		if err != nil {
			return r, err
		}
		if tag.RowsAffected() == 0 {
			var raw []byte
			if err = tx.QueryRow(ctx, `select to_jsonb(a) from library_activity a where id=$1`, id).Scan(&raw); err != nil {
				return r, err
			}
			var existing library.Activity
			if err = json.Unmarshal(raw, &existing); err != nil {
				return r, err
			}
			if existing.ItemID != v.ItemID || existing.Kind != v.Kind || existing.Occurred != libraryDate(v.Occurred) || !sameLibraryNumber(existing.DurationSeconds, v.DurationSeconds) {
				return r, fmt.Errorf("activity identity already refers to different observation: %w", library.ErrConflict)
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
		err = tx.QueryRow(ctx, `insert into library_collections(id,source,account,external_id,kind,title,description,search_text) values($1,$2,$3,$4,$5,$6,$7,$8)
   on conflict(id) do update set title=excluded.title,description=excluded.description,kind=excluded.kind,search_text=excluded.search_text where not library_collections.personal returning xmax=0`, id, v.Source, v.Account, v.ExternalID, v.Kind, v.Title, v.Description, v.Title+" "+v.Description).Scan(&inserted)
		if errors.Is(err, pgx.ErrNoRows) {
			return r, library.ErrConflict
		}
		if err != nil {
			return r, err
		}
		if inserted {
			r.Collections++
		}
		if v.Snapshot != nil {
			if _, err := insertLibrarySnapshot(ctx, tx, id, *v.Snapshot); err != nil {
				return r, err
			}
		}
	}
	for _, v := range b.Files {
		id, err := libraryID("file", v.Identity, v.ID)
		if err != nil {
			return r, err
		}
		var inserted bool
		err = tx.QueryRow(ctx, `insert into library_files(id,source,account,external_id,sha256,filename,mime_type,size_bytes,provenance,search_text) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
   on conflict(id) do update set filename=excluded.filename,mime_type=excluded.mime_type,provenance=excluded.provenance,search_text=excluded.search_text where library_files.sha256=excluded.sha256 and library_files.size_bytes=excluded.size_bytes returning xmax=0`, id, v.Source, v.Account, v.ExternalID, v.SHA256, v.Filename, v.MimeType, v.SizeBytes, v.Provenance, v.Filename+" "+v.MimeType).Scan(&inserted)
		if errors.Is(err, pgx.ErrNoRows) {
			return r, fmt.Errorf("file identity already refers to different bytes: %w", library.ErrConflict)
		}
		if err != nil {
			return r, err
		}
		if inserted {
			r.Files++
		}
		for _, itemID := range v.ItemIDs {
			if _, err := tx.Exec(ctx, `insert into library_item_files(item_id,file_id) values($1,$2) on conflict do nothing`, itemID, id); err != nil {
				return r, err
			}
		}
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
		err = tx.QueryRow(ctx, `insert into library_pages(id,source,account,external_id,path,title,body,answers,tags,aliases,content_hash,revision,sensitivity,provenance,search_text) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
   on conflict(id) do update set path=excluded.path,title=excluded.title,body=excluded.body,answers=excluded.answers,tags=excluded.tags,aliases=excluded.aliases,content_hash=excluded.content_hash,revision=excluded.revision,sensitivity=excluded.sensitivity,provenance=excluded.provenance,search_text=excluded.search_text returning xmax=0`, id, v.Source, v.Account, v.ExternalID, v.Path, v.Title, v.Body, libraryStrings(v.Answers), libraryStrings(v.Tags), libraryStrings(v.Aliases), v.ContentHash, v.Revision, v.Sensitivity, v.Provenance, strings.Join([]string{v.Title, v.Body, strings.Join(v.Answers, " "), strings.Join(v.Tags, " "), strings.Join(v.Aliases, " ")}, " ")).Scan(&inserted)
		if err != nil {
			return r, err
		}
		if inserted {
			r.Pages++
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
	var id int64
	err := tx.QueryRow(ctx, `insert into library_snapshots(collection_id,external_id,captured,completeness,provenance) values($1,$2,$3,$4,$5) on conflict(collection_id,external_id) do nothing returning id`, collectionID, snapshot.ExternalID, snapshot.Captured, snapshot.Completeness, snapshot.Provenance).Scan(&id)
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
		if _, err = tx.Exec(ctx, `insert into library_entries(snapshot_id,position,item_id,external_id,added) values($1,$2,$3,$4,$5)`, id, entry.Position, entry.ItemID, entry.ExternalID, entry.Added); err != nil {
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
	countLibraryImported(ctx, result, nil)
	return result, nil
}

func sameLibraryNumber(a, b *int) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

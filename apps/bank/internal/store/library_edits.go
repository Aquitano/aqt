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

func (s *Store) SetLibraryState(ctx context.Context, id string, edit library.StateEdit) (library.State, error) {
	var state library.State
	if err := edit.Validate(); err != nil {
		return state, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return state, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var itemID string
	if err = tx.QueryRow(ctx, `select id from library_items where id=$1 for update`, id).Scan(&itemID); errors.Is(err, pgx.ErrNoRows) {
		return state, ErrNotFound
	} else if err != nil {
		return state, err
	}
	var revision int64
	err = tx.QueryRow(ctx, `select revision from library_state where item_id=$1`, id).Scan(&revision)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return state, err
	}
	if revision != edit.ExpectedRevision {
		return state, library.ErrConflict
	}
	state = library.State{Revision: revision + 1, Status: edit.Status, Favorite: edit.Favorite, Progress: edit.Progress, ProgressUnit: edit.ProgressUnit, Rating: edit.Rating, Notes: edit.Notes, Tags: libraryStrings(edit.Tags)}
	_, err = tx.Exec(ctx, `insert into library_state(item_id,revision,status,favorite,progress,progress_unit,rating,notes,tags) values($1,$2,$3,$4,$5,$6,$7,$8,$9)
  on conflict(item_id) do update set revision=excluded.revision,status=excluded.status,favorite=excluded.favorite,progress=excluded.progress,progress_unit=excluded.progress_unit,rating=excluded.rating,notes=excluded.notes,tags=excluded.tags`, id, state.Revision, state.Status, state.Favorite, state.Progress, state.ProgressUnit, state.Rating, state.Notes, state.Tags)
	if err != nil {
		return library.State{}, err
	}
	if _, err = tx.Exec(ctx, `insert into library_state_edits(item_id,revision,state) values($1,$2,$3)`, id, state.Revision, state); err != nil {
		return library.State{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return library.State{}, err
	}
	return state, nil
}

func (s *Store) LibraryStateHistory(ctx context.Context, id string) ([]library.State, error) {
	out := []library.State{}
	var exists bool
	if err := s.pool.QueryRow(ctx, `select exists(select 1 from library_items where id=$1)`, id).Scan(&exists); err != nil {
		return out, err
	}
	if !exists {
		return out, ErrNotFound
	}
	rows, err := s.pool.Query(ctx, `select state from library_state_edits where item_id=$1 order by revision desc`, id)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		var v library.State
		if err = rows.Scan(&raw); err != nil {
			return out, err
		}
		if err = json.Unmarshal(raw, &v); err != nil {
			return out, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Store) CreateLibraryCollection(ctx context.Context, value library.Collection) (library.Collection, error) {
	check := value
	check.Personal = false
	check.Snapshot = nil
	if err := (library.ImportBatch{Version: 1, Collections: []library.Collection{check}}).Validate(); err != nil {
		return library.Collection{}, err
	}
	entries := []library.Entry{}
	if value.Snapshot != nil {
		entries = value.Snapshot.Entries
	}
	edit := library.CollectionEdit{Title: value.Title, Description: value.Description, Entries: entries}
	if err := edit.Validate(); err != nil {
		return library.Collection{}, err
	}
	id, err := libraryID("collection", value.Identity, value.ID)
	if err != nil {
		return library.Collection{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return library.Collection{}, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	tag, err := tx.Exec(ctx, `insert into library_collections(id,source,account,external_id,kind,title,description,personal,revision,search_text) values($1,$2,$3,$4,$5,$6,$7,true,1,$8) on conflict do nothing`, id, value.Source, value.Account, value.ExternalID, value.Kind, value.Title, value.Description, value.Title+" "+value.Description)
	if err != nil {
		return library.Collection{}, err
	}
	if tag.RowsAffected() == 0 {
		return library.Collection{}, library.ErrConflict
	}
	snapshot, err := writeLibraryCollectionEdit(ctx, tx, id, 1, edit)
	if err != nil {
		return library.Collection{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return library.Collection{}, err
	}
	value.ID = id
	value.Personal = true
	value.Revision = 1
	value.Snapshot = &snapshot
	return value, nil
}

func (s *Store) EditLibraryCollection(ctx context.Context, id string, edit library.CollectionEdit) (library.Collection, error) {
	var value library.Collection
	if err := edit.Validate(); err != nil {
		return value, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return value, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var raw []byte
	err = tx.QueryRow(ctx, `select to_jsonb(r)-'search_text' from library_collections r where id=$1 for update`, id).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return value, ErrNotFound
	}
	if err != nil {
		return value, err
	}
	if err = json.Unmarshal(raw, &value); err != nil {
		return value, err
	}
	if !value.Personal {
		return value, library.ErrReadOnly
	}
	if value.Revision != edit.ExpectedRevision {
		return value, library.ErrConflict
	}
	value.Revision++
	value.Title = edit.Title
	value.Description = edit.Description
	if _, err = tx.Exec(ctx, `update library_collections set revision=$2,title=$3,description=$4,search_text=$5 where id=$1`, id, value.Revision, value.Title, value.Description, value.Title+" "+value.Description); err != nil {
		return library.Collection{}, err
	}
	snapshot, err := writeLibraryCollectionEdit(ctx, tx, id, value.Revision, edit)
	if err != nil {
		return library.Collection{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return library.Collection{}, err
	}
	value.Snapshot = &snapshot
	return value, nil
}

func writeLibraryCollectionEdit(ctx context.Context, tx pgx.Tx, id string, revision int64, edit library.CollectionEdit) (library.Snapshot, error) {
	snapshot := library.Snapshot{ExternalID: fmt.Sprintf("revision:%d", revision), Captured: library.Date{Precision: "instant", Value: time.Now().UTC().Format(time.RFC3339Nano)}, Completeness: "complete", Entries: edit.Entries}
	if snapshot.Entries == nil {
		snapshot.Entries = []library.Entry{}
	}
	for i := range snapshot.Entries {
		snapshot.Entries[i].Added = libraryDate(snapshot.Entries[i].Added)
	}
	snapshotID, err := insertLibrarySnapshot(ctx, tx, id, snapshot)
	if err != nil {
		return library.Snapshot{}, err
	}
	_, err = tx.Exec(ctx, `insert into library_collection_edits(collection_id,revision,title,description,snapshot_id) values($1,$2,$3,$4,$5)`, id, revision, edit.Title, edit.Description, snapshotID)
	return snapshot, err
}

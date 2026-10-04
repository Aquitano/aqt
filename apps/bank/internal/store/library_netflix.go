package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/jackc/pgx/v5"
)

func reconcileNetflixActivity(ctx context.Context, tx pgx.Tx, id string, activity library.Activity) (string, error) {
	parts := strings.Split(activity.ExternalID, ":")
	if len(parts) != 4 || parts[0] != "viewing" || parts[2] != "occurrence" || activity.Kind != "watch" {
		return id, nil
	}
	occurrence, err := strconv.Atoi(parts[3])
	if err != nil || occurrence < 1 || occurrence > 100000 {
		return id, nil
	}
	date := libraryDate(activity.Occurred)
	sum := sha256.Sum256([]byte(activity.Title + "\x00" + date.Precision + "\x00" + date.Value))
	if parts[1] != hex.EncodeToString(sum[:]) {
		return id, nil
	}
	lock := library.StableID("netflix-reconciliation", library.Identity{Source: activity.Source, Account: activity.Account})
	if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1,0))`, lock); err != nil {
		return id, err
	}
	var canonicalID string
	err = tx.QueryRow(ctx, `select activity_id from library_activity_aliases where id=$1 union all select id from library_activity where id=$1 limit 1`, id).Scan(&canonicalID)
	if err == nil {
		return canonicalID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return id, err
	}
	// An export's row order establishes multiplicity, but cannot prove that separate exports describe the same event.
	err = tx.QueryRow(ctx, `with legacy as (
 select id,external_id,row_number() over(partition by split_part(external_id,':',2) order by split_part(external_id,':',4)::bigint,id) occurrence
 from library_activity where source=$1 and account=$2 and item_id=$3 and kind='watch' and occurred=$4
 and external_id ~ '^file:[0-9a-f]{64}:row:[0-9]+$'
 ) select id from legacy where occurrence=$5
 and not exists(select 1 from library_activity_aliases aliases where aliases.activity_id=legacy.id)
 order by external_id,id limit 1`, activity.Source, activity.Account, activity.ItemID, date, occurrence).Scan(&canonicalID)
	if errors.Is(err, pgx.ErrNoRows) {
		return id, nil
	}
	if err != nil {
		return id, err
	}
	if _, err := tx.Exec(ctx, `insert into library_activity_aliases(id,activity_id) values($1,$2)`, id, canonicalID); err != nil {
		return id, fmt.Errorf("reconcile Netflix identity: %w", err)
	}
	return canonicalID, nil
}

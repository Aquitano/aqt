package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/page"
)

// RawInput is one stored input and the outcome of its latest import.
type RawInput struct {
	ID         int64           `json:"id"`
	Kind       string          `json:"kind"`
	Name       string          `json:"name"`
	BLAKE3     content.Digest  `json:"blake3"`
	SizeBytes  int64           `json:"size_bytes"`
	Options    json.RawMessage `json:"options"`
	ReceivedAt time.Time       `json:"received_at"`
	FinishedAt *time.Time      `json:"finished_at"`
	// Status is running, complete, gaps or failed. An input that stays
	// running was interrupted.
	Status string        `json:"status"`
	Report ingest.Report `json:"report"`
	Error  string        `json:"error"`
}

// AddRawInput records an input whose bytes are already in the blob store and
// marks it running. The same bytes under the same name and options are the
// same input, so importing them again reruns that row.
func (s *Store) AddRawInput(ctx context.Context, kind, name string, d content.Digest, size int64, options json.RawMessage) (int64, error) {
	var id int64
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		contentID, err := upsertContent(ctx, tx, d, size)
		if err != nil {
			return err
		}
		return tx.QueryRow(ctx, `insert into raw_inputs (kind, content_id, name, options) values ($1, $2, $3, $4)
			on conflict (kind, content_id, name, options) do update
			set status = 'running', finished_at = null, report = '{}', error = ''
			returning id`, kind, contentID, cleanText(name), options).Scan(&id)
	})
	return id, err
}

// FinishRawInput records an import's outcome on its input.
func (s *Store) FinishRawInput(ctx context.Context, id int64, report ingest.Report, importErr error) error {
	status, problem := report.Status(), ""
	if importErr != nil {
		status, problem = "failed", cleanText(importErr.Error())
	}
	raw, err := json.Marshal(report)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	_, err = s.pool.Exec(ctx, `update raw_inputs set finished_at = now(), status = $2, report = $3, error = $4 where id = $1`,
		id, status, raw, problem)
	return err
}

const rawInputColumns = `r.id, r.kind, r.name, c.blake3, c.size_bytes, r.options, r.received_at, r.finished_at, r.status, r.report, r.error`

func scanRawInput(row pgx.Row) (RawInput, error) {
	var r RawInput
	var report []byte
	if err := row.Scan(&r.ID, &r.Kind, &r.Name, &r.BLAKE3, &r.SizeBytes, &r.Options, &r.ReceivedAt, &r.FinishedAt, &r.Status, &report, &r.Error); err != nil {
		return r, err
	}
	r.Report = ingest.NewReport()
	if err := json.Unmarshal(report, &r.Report); err != nil {
		return r, fmt.Errorf("raw input %d report: %w", r.ID, err)
	}
	return r, nil
}

// RawInputs lists inputs newest first, before an id when before is set.
func (s *Store) RawInputs(ctx context.Context, before int64, limit int) ([]RawInput, error) {
	limit = page.Limit(limit)
	if err := page.Check(limit, 0); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `select `+rawInputColumns+` from raw_inputs r join contents c on c.id = r.content_id
		where ($1::bigint = 0 or r.id < $1) order by r.id desc limit $2`, before, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (RawInput, error) { return scanRawInput(row) })
}

func (s *Store) RawInput(ctx context.Context, id int64) (RawInput, error) {
	r, err := scanRawInput(s.pool.QueryRow(ctx, `select `+rawInputColumns+` from raw_inputs r join contents c on c.id = r.content_id where r.id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return r, ErrNotFound
	}
	return r, err
}

// RawInputIDs lists the inputs of the given kinds, or of every kind, oldest
// first: the order a replay applies them in.
func (s *Store) RawInputIDs(ctx context.Context, kinds []string) ([]int64, error) {
	rows, err := s.pool.Query(ctx, `select id from raw_inputs where coalesce(cardinality($1::text[]), 0) = 0 or kind = any($1) order by id`, kinds)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[int64])
}

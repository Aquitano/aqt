package store

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/fail"
)

type ImportReport struct {
	ID         int64           `json:"id"`
	Kind       string          `json:"kind"`
	Input      string          `json:"input"`
	StartedAt  time.Time       `json:"started_at"`
	FinishedAt *time.Time      `json:"finished_at"`
	Status     string          `json:"status"`
	Result     json.RawMessage `json:"result"`
	Error      string          `json:"error"`
}

type importRunKey struct{}
type importRun struct {
	mu       sync.Mutex
	inserted int
	files    map[string]bool
	issues   []string
}

// ImportIssue retains diagnostics that would otherwise only reach stderr.
func ImportIssue(ctx context.Context, issue string) {
	if run, ok := ctx.Value(importRunKey{}).(*importRun); ok {
		run.mu.Lock()
		defer run.mu.Unlock()
		run.issues = append(run.issues, cleanText(issue))
	}
}

func countImported(ctx context.Context, inserted int, sum string) {
	if run, ok := ctx.Value(importRunKey{}).(*importRun); ok {
		run.mu.Lock()
		defer run.mu.Unlock()
		run.inserted += inserted
		if sum != "" {
			run.files[sum] = true
		}
	}
}

// RunImport records an attempt before reading input. Nested importers contribute
// to the same report. A process crash leaves a visible unfinished attempt.
func RunImport[T any](ctx context.Context, st *Store, kind, input string, run func(context.Context) (T, error)) (T, error) {
	if ctx.Value(importRunKey{}) != nil {
		return run(ctx)
	}
	var zero T
	var id int64
	if err := st.pool.QueryRow(ctx, `insert into import_reports(kind,input) values($1,$2) returning id`, kind, cleanText(input)).Scan(&id); err != nil {
		return zero, fail.Opf("start import report: %w", err)
	}
	counts := &importRun{files: map[string]bool{}}
	result, importErr := run(context.WithValue(ctx, importRunKey{}, counts))
	raw, err := json.Marshal(result)
	if err != nil {
		return result, errors.Join(importErr, err)
	}
	fields := map[string]any{}
	if err := json.Unmarshal(raw, &fields); err != nil {
		return result, errors.Join(importErr, err)
	}
	if fields == nil {
		fields = map[string]any{}
	}
	counts.mu.Lock()
	fields["inserted"] = counts.inserted
	fields["files_preserved"] = len(counts.files)
	if len(counts.issues) > 0 {
		fields["issues"] = counts.issues
	}
	counts.mu.Unlock()
	if kind == "chatgpt" || kind == "whatsapp" {
		if _, ok := fields["missing_media"]; !ok {
			fields["missing_media"] = float64(0)
		}
	}
	if kind == "chatgpt" {
		if _, ok := fields["unsupported_content"]; !ok {
			fields["unsupported_content"] = float64(0)
		}
	}
	status := "complete"
	for _, key := range []string{"skipped", "rejected", "damaged", "missing_media", "unsupported_content", "empty_conversations", "missing_shards"} {
		if value, ok := fields[key].(float64); ok && value > 0 {
			status = "gaps"
		}
	}
	for _, key := range []string{"failed_sessions", "failed_channels", "issues"} {
		switch value := fields[key].(type) {
		case []any:
			if len(value) > 0 {
				status = "gaps"
			}
		case []string:
			if len(value) > 0 {
				status = "gaps"
			}
		}
	}
	problem := ""
	if importErr != nil {
		status = "failed"
		problem = cleanText(importErr.Error())
	}
	raw, err = json.Marshal(fields)
	if err != nil {
		return result, errors.Join(importErr, err)
	}
	finishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	_, err = st.pool.Exec(finishCtx, `update import_reports set finished_at=now(),status=$2,result=$3,error=$4 where id=$1`, id, status, raw, problem)
	if err != nil {
		return result, errors.Join(importErr, fail.Opf("save import report %d: %w", id, err))
	}
	return result, importErr
}

func (s *Store) ImportReports(ctx context.Context, before int64, limit int) ([]ImportReport, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `select id,kind,input,started_at,finished_at,status,result,error from import_reports where ($1::bigint=0 or id<$1) order by id desc limit $2`, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	reports := []ImportReport{}
	for rows.Next() {
		var r ImportReport
		if err := rows.Scan(&r.ID, &r.Kind, &r.Input, &r.StartedAt, &r.FinishedAt, &r.Status, &r.Result, &r.Error); err != nil {
			return nil, err
		}
		reports = append(reports, r)
	}
	return reports, rows.Err()
}

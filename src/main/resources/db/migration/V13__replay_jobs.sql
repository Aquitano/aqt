CREATE TABLE replay_jobs
(
    id                 TEXT PRIMARY KEY,
    scope              TEXT        NOT NULL CHECK (scope IN ('projections', 'derived', 'all')),
    metric_types       TEXT,
    from_date          DATE,
    to_date            DATE,
    wipe               BOOLEAN     NOT NULL DEFAULT FALSE,
    status             TEXT        NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    total_items        INTEGER     NOT NULL DEFAULT 0,
    completed_items    INTEGER     NOT NULL DEFAULT 0,
    current_item       TEXT,
    records_replayed   INTEGER     NOT NULL DEFAULT 0,
    metrics_written    INTEGER     NOT NULL DEFAULT 0,
    duplicates_skipped INTEGER     NOT NULL DEFAULT 0,
    mapping_failures   INTEGER     NOT NULL DEFAULT 0,
    error_message      TEXT,
    created_at         TIMESTAMPTZ NOT NULL,
    started_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ NOT NULL,
    finished_at        TIMESTAMPTZ,
    CHECK (from_date IS NULL OR to_date IS NULL OR from_date <= to_date),
    CHECK (total_items >= 0),
    CHECK (completed_items >= 0)
);

CREATE INDEX replay_jobs_status_created_idx
    ON replay_jobs (status, created_at DESC);

-- Activity summary records were stored without record_start_at/record_end_at, which would
-- make them invisible to date-ranged replay. Derive the day window from the normalized record.
UPDATE ingestion_records
SET record_start_at = ((normalized_record_json ->> 'date')::date)::timestamp AT TIME ZONE 'UTC',
    record_end_at   = (((normalized_record_json ->> 'date')::date + 1))::timestamp AT TIME ZONE 'UTC'
WHERE record_type = 'activity_summary'
  AND record_start_at IS NULL
  AND normalized_record_json ->> 'date' IS NOT NULL;

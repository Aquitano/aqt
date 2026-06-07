CREATE TABLE provider_sync_jobs
(
    id                       TEXT PRIMARY KEY,
    provider_code            TEXT        NOT NULL,
    provider_instance_id     TEXT,
    requested_from           TIMESTAMPTZ NOT NULL,
    requested_to             TIMESTAMPTZ NOT NULL,
    data_types               TEXT,
    page_size                INTEGER,
    status                   TEXT        NOT NULL CHECK (status IN ('queued', 'running', 'processed', 'failed', 'partial_failed')),
    total_items              INTEGER     NOT NULL DEFAULT 0,
    completed_items          INTEGER     NOT NULL DEFAULT 0,
    current_data_type        TEXT,
    current_from             TIMESTAMPTZ,
    current_to               TIMESTAMPTZ,
    last_completed_data_type TEXT,
    last_completed_from      TIMESTAMPTZ,
    last_completed_to        TIMESTAMPTZ,
    batches_count            INTEGER     NOT NULL DEFAULT 0,
    empty_count              INTEGER     NOT NULL DEFAULT 0,
    error_count              INTEGER     NOT NULL DEFAULT 0,
    summary_json             TEXT,
    error_message            TEXT,
    created_at               TIMESTAMPTZ NOT NULL,
    started_at               TIMESTAMPTZ,
    updated_at               TIMESTAMPTZ NOT NULL,
    finished_at              TIMESTAMPTZ,
    CHECK (requested_from < requested_to),
    CHECK (page_size IS NULL OR page_size > 0),
    CHECK (total_items >= 0),
    CHECK (completed_items >= 0)
);

CREATE INDEX provider_sync_jobs_provider_created_idx
    ON provider_sync_jobs (provider_code, created_at DESC);

CREATE INDEX provider_sync_jobs_status_idx
    ON provider_sync_jobs (status);

CREATE TABLE sources
(
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code         TEXT NOT NULL UNIQUE,
    display_name TEXT,
    created_at   TEXT NOT NULL
);

CREATE TABLE source_instances
(
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id            INTEGER NOT NULL REFERENCES sources (id),
    provider_instance_id TEXT    NOT NULL,
    display_name         TEXT,
    created_at           TEXT    NOT NULL,
    updated_at           TEXT    NOT NULL,
    UNIQUE (source_id, provider_instance_id)
);

CREATE TABLE api_clients
(
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL UNIQUE,
    api_key_hash TEXT    NOT NULL UNIQUE,
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT    NOT NULL,
    last_used_at TEXT
);

CREATE TABLE raw_ingestion_batches
(
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    source_instance_id  INTEGER NOT NULL REFERENCES source_instances (id),
    batch_external_id   TEXT,
    raw_payload_json    TEXT    NOT NULL,
    mapped_payload_json TEXT    NOT NULL,
    status              TEXT    NOT NULL,
    ingested_at         TEXT    NOT NULL,
    received_at         TEXT    NOT NULL,
    processed_at        TEXT,
    error_message       TEXT,
    created_at          TEXT    NOT NULL,
    updated_at          TEXT    NOT NULL
);

CREATE UNIQUE INDEX raw_ingestion_batches_source_instance_batch_external_id_uq
    ON raw_ingestion_batches (source_instance_id, batch_external_id)
    WHERE batch_external_id IS NOT NULL;

CREATE TABLE raw_ingestion_records
(
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id           INTEGER NOT NULL REFERENCES raw_ingestion_batches (id),
    record_type        TEXT    NOT NULL,
    provider_record_id TEXT,
    record_json        TEXT    NOT NULL,
    record_start_at    TEXT,
    record_end_at      TEXT,
    created_at         TEXT    NOT NULL
);

CREATE UNIQUE INDEX raw_ingestion_records_batch_provider_record_id_uq
    ON raw_ingestion_records (batch_id, provider_record_id)
    WHERE provider_record_id IS NOT NULL;

CREATE TABLE step_samples
(
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    source_instance_id INTEGER NOT NULL REFERENCES source_instances (id),
    raw_record_id      INTEGER REFERENCES raw_ingestion_records (id),
    provider_record_id TEXT,
    start_at           TEXT    NOT NULL,
    end_at             TEXT    NOT NULL,
    steps              INTEGER NOT NULL,
    created_at         TEXT    NOT NULL
);

CREATE UNIQUE INDEX step_samples_source_instance_provider_record_id_uq
    ON step_samples (source_instance_id, provider_record_id)
    WHERE provider_record_id IS NOT NULL;

CREATE TABLE step_daily_summaries
(
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    date               TEXT    NOT NULL,
    source_instance_id INTEGER NOT NULL REFERENCES source_instances (id),
    steps              INTEGER NOT NULL,
    sample_count       INTEGER NOT NULL,
    computed_at        TEXT    NOT NULL,
    UNIQUE (date, source_instance_id)
);

CREATE TABLE sleep_sessions
(
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    source_instance_id INTEGER NOT NULL REFERENCES source_instances (id),
    raw_record_id      INTEGER REFERENCES raw_ingestion_records (id),
    provider_record_id TEXT,
    start_at           TEXT    NOT NULL,
    end_at             TEXT    NOT NULL,
    duration_seconds   INTEGER NOT NULL,
    created_at         TEXT    NOT NULL
);

CREATE UNIQUE INDEX sleep_sessions_source_instance_provider_record_id_uq
    ON sleep_sessions (source_instance_id, provider_record_id)
    WHERE provider_record_id IS NOT NULL;

CREATE TABLE sleep_stages
(
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    sleep_session_id INTEGER NOT NULL REFERENCES sleep_sessions (id) ON DELETE CASCADE,
    stage            TEXT    NOT NULL,
    start_at         TEXT    NOT NULL,
    end_at           TEXT    NOT NULL,
    duration_seconds INTEGER NOT NULL
);

CREATE TABLE body_measurements
(
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    source_instance_id INTEGER NOT NULL REFERENCES source_instances (id),
    raw_record_id      INTEGER REFERENCES raw_ingestion_records (id),
    provider_record_id TEXT,
    measured_at        TEXT    NOT NULL,
    metric_type        TEXT    NOT NULL,
    value              REAL    NOT NULL,
    unit               TEXT    NOT NULL,
    created_at         TEXT    NOT NULL
);

CREATE UNIQUE INDEX body_measurements_source_instance_provider_record_id_metric_type_uq
    ON body_measurements (source_instance_id, provider_record_id, metric_type)
    WHERE provider_record_id IS NOT NULL;

CREATE TABLE heart_rate_samples
(
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    source_instance_id INTEGER NOT NULL REFERENCES source_instances (id),
    raw_record_id      INTEGER REFERENCES raw_ingestion_records (id),
    provider_record_id TEXT,
    measured_at        TEXT    NOT NULL,
    bpm                INTEGER NOT NULL,
    context            TEXT,
    created_at         TEXT    NOT NULL
);

CREATE UNIQUE INDEX heart_rate_samples_source_instance_provider_record_id_uq
    ON heart_rate_samples (source_instance_id, provider_record_id)
    WHERE provider_record_id IS NOT NULL;

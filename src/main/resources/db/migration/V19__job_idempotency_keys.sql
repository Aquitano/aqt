ALTER TABLE provider_sync_jobs
    ADD COLUMN idempotency_key TEXT,
    ADD COLUMN idempotency_request_hash TEXT;

CREATE UNIQUE INDEX provider_sync_jobs_provider_idempotency_key_uq
    ON provider_sync_jobs (provider_code, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

ALTER TABLE replay_jobs
    ADD COLUMN idempotency_key TEXT,
    ADD COLUMN idempotency_request_hash TEXT;

CREATE UNIQUE INDEX replay_jobs_idempotency_key_uq
    ON replay_jobs (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Synchronous provider sync has no job row, so replayed keys return the stored response.
CREATE TABLE provider_sync_idempotency
(
    provider_code   TEXT        NOT NULL,
    idempotency_key TEXT        NOT NULL,
    request_hash    TEXT        NOT NULL,
    response_json   TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (provider_code, idempotency_key)
);

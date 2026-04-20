CREATE TABLE provider_oauth_accounts
(
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_code            TEXT NOT NULL,
    provider_user_id         TEXT NOT NULL,
    provider_instance_id     TEXT NOT NULL,
    access_token_ciphertext  TEXT NOT NULL,
    refresh_token_ciphertext TEXT NOT NULL,
    token_type               TEXT NOT NULL,
    expires_at               TEXT NOT NULL,
    scope                    TEXT NOT NULL,
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL,
    UNIQUE (provider_code, provider_user_id)
);

CREATE TABLE provider_oauth_states
(
    state         TEXT PRIMARY KEY,
    provider_code TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    consumed_at   TEXT
);

CREATE TABLE provider_sync_runs
(
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_code        TEXT NOT NULL,
    provider_instance_id TEXT NOT NULL,
    requested_from       TEXT NOT NULL,
    requested_to         TEXT NOT NULL,
    status               TEXT NOT NULL,
    started_at           TEXT NOT NULL,
    finished_at          TEXT,
    error_message        TEXT
);

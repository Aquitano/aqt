ALTER TABLE provider_oauth_accounts
    ADD COLUMN account_status TEXT NOT NULL DEFAULT 'connected',
    ADD COLUMN connected_at TIMESTAMPTZ,
    ADD COLUMN disconnected_at TIMESTAMPTZ,
    ADD COLUMN last_token_refresh_at TIMESTAMPTZ,
    ADD COLUMN last_token_refresh_status TEXT,
    ADD COLUMN last_auth_error_code TEXT,
    ADD COLUMN last_auth_error_message TEXT;

UPDATE provider_oauth_accounts
SET connected_at = created_at
WHERE connected_at IS NULL;

ALTER TABLE provider_oauth_accounts
    ADD CONSTRAINT provider_oauth_accounts_account_status_check
        CHECK (account_status IN ('connected', 'needs_reauth', 'disconnected')),
    ADD CONSTRAINT provider_oauth_accounts_token_refresh_status_check
        CHECK (last_token_refresh_status IS NULL OR last_token_refresh_status IN ('success', 'failed'));

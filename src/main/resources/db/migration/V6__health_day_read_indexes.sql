CREATE INDEX IF NOT EXISTS step_samples_start_idx
    ON step_samples (start_at);

CREATE INDEX IF NOT EXISTS heart_rate_samples_measured_idx
    ON heart_rate_samples (measured_at);

CREATE INDEX IF NOT EXISTS body_measurements_metric_measured_idx
    ON body_measurements (metric_type, measured_at);

CREATE INDEX IF NOT EXISTS sleep_sessions_start_end_idx
    ON sleep_sessions (start_at, end_at);

CREATE INDEX IF NOT EXISTS sleep_sessions_end_idx
    ON sleep_sessions (end_at);

CREATE INDEX IF NOT EXISTS sleep_stages_session_start_idx
    ON sleep_stages (sleep_session_id, start_at);

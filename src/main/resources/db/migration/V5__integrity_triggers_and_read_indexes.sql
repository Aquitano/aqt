CREATE TRIGGER ingestion_batches_status_insert_ck
    BEFORE INSERT ON ingestion_batches
    WHEN NEW.status NOT IN ('received', 'processed', 'failed')
BEGIN
    SELECT RAISE(ABORT, 'invalid ingestion batch status');
END;

CREATE TRIGGER ingestion_batches_status_update_ck
    BEFORE UPDATE OF status ON ingestion_batches
    WHEN NEW.status NOT IN ('received', 'processed', 'failed')
BEGIN
    SELECT RAISE(ABORT, 'invalid ingestion batch status');
END;

CREATE TRIGGER ingestion_records_type_insert_ck
    BEFORE INSERT ON ingestion_records
    WHEN NEW.record_type NOT IN ('step_interval', 'sleep_session', 'body_measurement', 'heart_rate')
BEGIN
    SELECT RAISE(ABORT, 'invalid ingestion record type');
END;

CREATE TRIGGER ingestion_records_type_update_ck
    BEFORE UPDATE OF record_type ON ingestion_records
    WHEN NEW.record_type NOT IN ('step_interval', 'sleep_session', 'body_measurement', 'heart_rate')
BEGIN
    SELECT RAISE(ABORT, 'invalid ingestion record type');
END;

CREATE TRIGGER step_samples_insert_ck
    BEFORE INSERT ON step_samples
    WHEN NEW.start_at >= NEW.end_at OR NEW.steps <= 0
BEGIN
    SELECT RAISE(ABORT, 'invalid step sample');
END;

CREATE TRIGGER step_samples_update_ck
    BEFORE UPDATE OF start_at, end_at, steps ON step_samples
    WHEN NEW.start_at >= NEW.end_at OR NEW.steps <= 0
BEGIN
    SELECT RAISE(ABORT, 'invalid step sample');
END;

CREATE TRIGGER step_daily_summaries_insert_ck
    BEFORE INSERT ON step_daily_summaries
    WHEN NEW.steps < 0 OR NEW.sample_count <= 0
BEGIN
    SELECT RAISE(ABORT, 'invalid step daily summary');
END;

CREATE TRIGGER step_daily_summaries_update_ck
    BEFORE UPDATE OF steps, sample_count ON step_daily_summaries
    WHEN NEW.steps < 0 OR NEW.sample_count <= 0
BEGIN
    SELECT RAISE(ABORT, 'invalid step daily summary');
END;

CREATE TRIGGER sleep_sessions_insert_ck
    BEFORE INSERT ON sleep_sessions
    WHEN NEW.start_at >= NEW.end_at OR NEW.duration_seconds <= 0
BEGIN
    SELECT RAISE(ABORT, 'invalid sleep session');
END;

CREATE TRIGGER sleep_sessions_update_ck
    BEFORE UPDATE OF start_at, end_at, duration_seconds ON sleep_sessions
    WHEN NEW.start_at >= NEW.end_at OR NEW.duration_seconds <= 0
BEGIN
    SELECT RAISE(ABORT, 'invalid sleep session');
END;

CREATE TRIGGER sleep_stages_insert_ck
    BEFORE INSERT ON sleep_stages
    WHEN NEW.stage NOT IN ('awake', 'restless', 'asleep', 'light', 'deep', 'rem', 'unknown')
        OR NEW.start_at >= NEW.end_at
        OR NEW.duration_seconds <= 0
BEGIN
    SELECT RAISE(ABORT, 'invalid sleep stage');
END;

CREATE TRIGGER sleep_stages_update_ck
    BEFORE UPDATE OF stage, start_at, end_at, duration_seconds ON sleep_stages
    WHEN NEW.stage NOT IN ('awake', 'restless', 'asleep', 'light', 'deep', 'rem', 'unknown')
        OR NEW.start_at >= NEW.end_at
        OR NEW.duration_seconds <= 0
BEGIN
    SELECT RAISE(ABORT, 'invalid sleep stage');
END;

CREATE TRIGGER body_measurements_insert_ck
    BEFORE INSERT ON body_measurements
    WHEN NEW.metric_type NOT IN ('weight', 'body_fat', 'muscle', 'water', 'visceral_fat')
        OR (NEW.metric_type IN ('weight', 'muscle') AND (NEW.unit != 'kg' OR NEW.value <= 0))
        OR (NEW.metric_type IN ('body_fat', 'water') AND (NEW.unit != 'percent' OR NEW.value < 0 OR NEW.value > 100))
        OR (NEW.metric_type = 'visceral_fat' AND (NEW.unit != 'rating' OR NEW.value <= 0))
BEGIN
    SELECT RAISE(ABORT, 'invalid body measurement');
END;

CREATE TRIGGER body_measurements_update_ck
    BEFORE UPDATE OF metric_type, unit, value ON body_measurements
    WHEN NEW.metric_type NOT IN ('weight', 'body_fat', 'muscle', 'water', 'visceral_fat')
        OR (NEW.metric_type IN ('weight', 'muscle') AND (NEW.unit != 'kg' OR NEW.value <= 0))
        OR (NEW.metric_type IN ('body_fat', 'water') AND (NEW.unit != 'percent' OR NEW.value < 0 OR NEW.value > 100))
        OR (NEW.metric_type = 'visceral_fat' AND (NEW.unit != 'rating' OR NEW.value <= 0))
BEGIN
    SELECT RAISE(ABORT, 'invalid body measurement');
END;

CREATE TRIGGER heart_rate_samples_insert_ck
    BEFORE INSERT ON heart_rate_samples
    WHEN NEW.bpm NOT BETWEEN 25 AND 250
        OR NEW.context NOT IN ('resting', 'active', 'workout', 'sleep', 'general', 'unknown')
BEGIN
    SELECT RAISE(ABORT, 'invalid heart rate sample');
END;

CREATE TRIGGER heart_rate_samples_update_ck
    BEFORE UPDATE OF bpm, context ON heart_rate_samples
    WHEN NEW.bpm NOT BETWEEN 25 AND 250
        OR NEW.context NOT IN ('resting', 'active', 'workout', 'sleep', 'general', 'unknown')
BEGIN
    SELECT RAISE(ABORT, 'invalid heart rate sample');
END;

CREATE TRIGGER provider_sync_runs_insert_ck
    BEFORE INSERT ON provider_sync_runs
    WHEN NEW.status NOT IN ('running', 'processed', 'failed', 'partial_failed')
        OR NEW.requested_from >= NEW.requested_to
BEGIN
    SELECT RAISE(ABORT, 'invalid provider sync run');
END;

CREATE TRIGGER provider_sync_runs_update_ck
    BEFORE UPDATE OF status, requested_from, requested_to ON provider_sync_runs
    WHEN NEW.status NOT IN ('running', 'processed', 'failed', 'partial_failed')
        OR NEW.requested_from >= NEW.requested_to
BEGIN
    SELECT RAISE(ABORT, 'invalid provider sync run');
END;

CREATE INDEX IF NOT EXISTS step_samples_source_instance_start_idx
    ON step_samples (source_instance_id, start_at);

CREATE INDEX IF NOT EXISTS sleep_sessions_source_instance_start_idx
    ON sleep_sessions (source_instance_id, start_at);

CREATE INDEX IF NOT EXISTS body_measurements_source_instance_metric_measured_idx
    ON body_measurements (source_instance_id, metric_type, measured_at);

CREATE INDEX IF NOT EXISTS heart_rate_samples_source_instance_measured_idx
    ON heart_rate_samples (source_instance_id, measured_at);

CREATE INDEX IF NOT EXISTS step_daily_summaries_source_instance_date_idx
    ON step_daily_summaries (source_instance_id, date);

CREATE INDEX IF NOT EXISTS ingestion_batches_status_received_idx
    ON ingestion_batches (status, received_at);

CREATE INDEX IF NOT EXISTS ingestion_records_batch_id_idx
    ON ingestion_records (batch_id);

CREATE INDEX IF NOT EXISTS provider_oauth_accounts_provider_instance_idx
    ON provider_oauth_accounts (provider_code, provider_instance_id);

CREATE INDEX IF NOT EXISTS provider_sync_runs_provider_instance_started_idx
    ON provider_sync_runs (provider_code, provider_instance_id, started_at);

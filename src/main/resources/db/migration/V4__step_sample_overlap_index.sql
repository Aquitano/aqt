CREATE INDEX IF NOT EXISTS step_samples_source_instance_start_end_idx
    ON step_samples (source_instance_id, start_at, end_at);

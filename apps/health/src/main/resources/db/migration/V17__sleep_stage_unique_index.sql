-- M5: sleep stages had only a non-unique (sleep_session_id, start_at) index, so a replay or any
-- future writer that re-inserts stages for an existing session would double them and inflate stage
-- totals. Dedupe any pre-existing duplicates (keeping the earliest row), then enforce uniqueness on
-- (sleep_session_id, start_at, stage). The unique index also covers the old index's query prefix.

DELETE FROM sleep_stages a
    USING sleep_stages b
WHERE a.id > b.id
  AND a.sleep_session_id = b.sleep_session_id
  AND a.start_at = b.start_at
  AND a.stage = b.stage;

DROP INDEX sleep_stages_session_start_idx;

CREATE UNIQUE INDEX sleep_stages_session_start_stage_uq
    ON sleep_stages (sleep_session_id, start_at, stage);

-- M2: scalar_samples_provider_record_uq is partial (WHERE provider_record_id IS NOT NULL), so rows
-- without a stable provider record id (derived metrics, some Google feeds) had no uniqueness and
-- accumulated duplicates across re-syncs. Dedupe the existing id-less rows on their natural key
-- (keeping the earliest row), then add a complementary partial unique index for the NULL case.

DELETE FROM scalar_samples a
    USING scalar_samples b
WHERE a.provider_record_id IS NULL
  AND b.provider_record_id IS NULL
  AND a.id > b.id
  AND a.source_instance_id = b.source_instance_id
  AND a.metric_type = b.metric_type
  AND a.measured_at = b.measured_at
  AND COALESCE(a.segment, '') = COALESCE(b.segment, '');

CREATE UNIQUE INDEX scalar_samples_natural_key_uq
    ON scalar_samples (source_instance_id, metric_type, measured_at, COALESCE(segment, ''))
    WHERE provider_record_id IS NULL;

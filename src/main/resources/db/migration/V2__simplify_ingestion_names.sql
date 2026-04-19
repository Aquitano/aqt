DROP INDEX IF EXISTS raw_ingestion_batches_source_instance_batch_external_id_uq;
DROP INDEX IF EXISTS raw_ingestion_records_batch_provider_record_id_uq;

ALTER TABLE raw_ingestion_batches RENAME TO ingestion_batches;
ALTER TABLE raw_ingestion_records RENAME TO ingestion_records;

ALTER TABLE ingestion_batches RENAME COLUMN raw_payload_json TO source_payload_json;
ALTER TABLE ingestion_batches RENAME COLUMN mapped_payload_json TO normalized_payload_json;
ALTER TABLE ingestion_records RENAME COLUMN record_json TO normalized_record_json;

ALTER TABLE step_samples RENAME COLUMN raw_record_id TO ingestion_record_id;
ALTER TABLE sleep_sessions RENAME COLUMN raw_record_id TO ingestion_record_id;
ALTER TABLE body_measurements RENAME COLUMN raw_record_id TO ingestion_record_id;
ALTER TABLE heart_rate_samples RENAME COLUMN raw_record_id TO ingestion_record_id;

CREATE UNIQUE INDEX ingestion_batches_source_instance_batch_external_id_uq
    ON ingestion_batches (source_instance_id, batch_external_id)
    WHERE batch_external_id IS NOT NULL;

CREATE UNIQUE INDEX ingestion_records_batch_provider_record_id_uq
    ON ingestion_records (batch_id, provider_record_id)
    WHERE provider_record_id IS NOT NULL;

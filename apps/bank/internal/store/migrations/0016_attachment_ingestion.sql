alter table attachments add column ingested_at timestamptz;
alter table attachments alter column ingested_at set default clock_timestamp();

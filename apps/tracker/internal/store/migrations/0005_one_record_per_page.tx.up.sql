delete from derivations;
delete from records;

alter table records drop constraint records_extractor_record_hash_key;
alter table records alter column canonical_url set not null;
alter table records add constraint records_extractor_canonical_url_key unique (extractor, canonical_url);

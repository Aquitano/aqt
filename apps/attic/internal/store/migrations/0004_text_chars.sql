-- stats sums document lengths; counting them on every call decompressed every
-- stored text.
alter table texts add column chars integer generated always as (char_length(text)) stored;

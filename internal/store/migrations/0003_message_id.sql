-- RFC 822 Message-ID, stored separately from external_id so mail that arrives
-- twice under different id schemes (Gmail API id vs Takeout mbox) still dedups.
alter table messages add column message_id text not null default '';
create index messages_message_id_idx on messages (source, message_id) where message_id <> '';

alter table mail_details
    add column header_message_id text not null default '',
    add column header_raw_ref text not null default '';

update mail_details set header_message_id=substring(node_key from 5)
where node_key like 'rfc:%';

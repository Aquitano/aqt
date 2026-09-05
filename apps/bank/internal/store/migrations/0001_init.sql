create table messages (
    id          bigint generated always as identity primary key,
    source      text not null,
    external_id text not null,
    thread_id   text not null default '',
    sender      text not null default '',
    recipients  text[] not null default '{}',
    subject     text not null default '',
    body        text not null default '',
    sent_at     timestamptz not null,
    raw_ref     text not null default '',
    ingested_at timestamptz not null default now(),
    unique (source, external_id)
);

create table attachments (
    id         bigint generated always as identity primary key,
    message_id bigint not null references messages (id) on delete cascade,
    filename   text not null,
    mime_type  text not null default '',
    size_bytes bigint not null,
    sha256     text not null
);

create index messages_sent_at_idx on messages (sent_at);
create index messages_source_idx on messages (source);
create index attachments_message_id_idx on attachments (message_id);
create index attachments_sha256_idx on attachments (sha256);

create index messages_bm25_idx on messages
    using bm25 (id, subject, body, sender)
    with (key_field = 'id');

create table mailboxes (
    id bigint generated always as identity primary key,
    source text not null,
    kind text not null check (kind in ('export', 'imap')),
    path text not null,
    unique (source, kind, path)
);

create table mailbox_messages (
    mailbox_id bigint not null references mailboxes(id) on delete cascade,
    message_id bigint not null references messages(id) on delete cascade,
    primary key (mailbox_id, message_id)
);

create index mailbox_messages_message on mailbox_messages(message_id);

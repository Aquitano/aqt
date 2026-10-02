create table mail_thread_nodes (
    source text not null,
    node_key text not null,
    thread_id text not null default '',
    conflict_key text not null default '',
    primary key(source,node_key)
);

create table mail_details (
    message_id bigint primary key references messages(id) on delete cascade,
    source text not null,
    node_key text not null,
    in_reply_to text[] not null default '{}',
    reference_ids text[] not null default '{}',
    native_thread_id text not null default '',
    incomplete boolean not null default false,
    foreign key(source,node_key) references mail_thread_nodes(source,node_key)
);
create index mail_details_node on mail_details(source,node_key);
create index mail_details_native on mail_details(source,native_thread_id) where native_thread_id<>'';

create table mail_thread_edges (
    source text not null,
    owner_id bigint not null references messages(id) on delete cascade,
    left_node text not null,
    right_node text not null,
    primary key(source,owner_id,left_node,right_node),
    foreign key(source,left_node) references mail_thread_nodes(source,node_key),
    foreign key(source,right_node) references mail_thread_nodes(source,node_key)
);
create index mail_thread_edges_left on mail_thread_edges(source,left_node);
create index mail_thread_edges_right on mail_thread_edges(source,right_node);

create table mail_thread_conflicts (
    source text not null,
    conflict_key text not null,
    node_keys text[] not null,
    primary key(source,conflict_key)
);
create index mail_thread_conflicts_nodes on mail_thread_conflicts using gin(node_keys);

create table mail_thread_aliases (
    source text not null,
    old_id text not null,
    current_id text,
    conflict_key text,
    primary key(source,old_id),
    check ((current_id is null) <> (conflict_key is null))
);
create index mail_thread_aliases_conflict on mail_thread_aliases(source,conflict_key);

create table mail_rebuild_progress (
    source text not null,
    work_key text not null,
    completed_at timestamptz not null default now(),
    primary key(source,work_key)
);

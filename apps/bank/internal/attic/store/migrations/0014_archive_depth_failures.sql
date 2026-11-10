create table archive_depth_failures (
    content_id bigint not null references archives on delete cascade,
    depth integer not null check (depth > 0),
    unpack_max_bytes bigint not null check (unpack_max_bytes >= 0),
    primary key (content_id, depth, unpack_max_bytes)
);

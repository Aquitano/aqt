create table metadata (
    content_id bigint primary key references contents,
    status text not null,
    detail text not null default '',
    tags jsonb not null,
    text text not null default '',
    extracted_at timestamptz not null default now()
);
create index metadata_bm25_idx on metadata using bm25 (
    content_id,
    (text::pdb.unicode_words('ascii_folding=true'))
) with (key_field = 'content_id');
alter table scans
    add column metadata bigint not null default 0,
    add column metadata_ms bigint not null default 0;

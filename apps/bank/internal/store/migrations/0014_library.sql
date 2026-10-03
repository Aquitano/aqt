create table library_items (
 id text primary key,
 source text not null check (source <> ''), account text not null, external_id text not null check (external_id <> ''),
 kind text not null check (kind in ('video','movie','series','episode','track','album','podcast','book','article','other')),
 title text not null check (title <> ''), description text not null default '', url text not null default '',
 provider text not null default '', provider_id text not null default '',
 creators text[] not null default '{}', series text not null default '', album text not null default '', year integer check(year between 1 and 9999),
 season integer check (season >= 0), episode integer check (episode >= 0), duration_seconds integer check (duration_seconds >= 0),
 provenance jsonb not null default '{}', search_text text not null,
 unique (source,account,external_id), check ((provider='')=(provider_id=''))
);
create index library_items_search on library_items using gin (to_tsvector('simple',search_text));
create index library_items_provider on library_items(provider,provider_id) where provider_id<>'';

create table library_activity (
 id text primary key,
 source text not null check (source <> ''), account text not null, external_id text not null check (external_id <> ''),
 item_id text not null references library_items(id),
 kind text not null check (kind in ('watch','listen','read','play','view','purchase','other')),
 title text not null default '', occurred jsonb not null,
 duration_seconds integer check (duration_seconds>=0), provenance jsonb not null default '{}', search_text text not null,
 unique(source,account,external_id),
 check (occurred->>'precision' in ('unknown','day','instant')),
 check (((occurred->>'precision')='unknown')=((occurred->>'value')=''))
);
create index library_activity_search on library_activity using gin (to_tsvector('simple',search_text));
create index library_activity_item on library_activity(item_id);

create table library_collections (
 id text primary key,
 source text not null check(source<>''), account text not null, external_id text not null check(external_id<>''),
 kind text not null check(kind in ('playlist','library','watchlist','list')),
 title text not null check(title<>''), description text not null default '', personal boolean not null default false,
 revision bigint not null default 0 check(revision>=0), search_text text not null,
 unique(source,account,external_id)
);
create index library_collections_search on library_collections using gin(to_tsvector('simple',search_text));
create table library_snapshots (
 id bigint generated always as identity primary key,
 collection_id text not null references library_collections(id), external_id text not null check(external_id<>''),
 captured jsonb not null, completeness text not null check(completeness in ('complete','partial','unknown')),
 provenance jsonb not null default '{}',
 unique(collection_id,external_id),
 check(captured->>'precision' in ('unknown','day','instant')),
 check(((captured->>'precision')='unknown')=((captured->>'value')=''))
);
create table library_entries (
 snapshot_id bigint not null references library_snapshots(id), position integer not null check(position>=0),
 item_id text not null references library_items(id), external_id text not null default '', added jsonb not null,
 primary key(snapshot_id,position),
 check(added->>'precision' in ('unknown','day','instant')),
 check(((added->>'precision')='unknown')=((added->>'value')=''))
);
create table library_collection_edits (
 collection_id text not null references library_collections(id), revision bigint not null check(revision>0),
 title text not null, description text not null, snapshot_id bigint not null references library_snapshots(id),
 edited_at timestamptz not null default now(), primary key(collection_id,revision)
);

create table library_state (
 item_id text primary key references library_items(id), revision bigint not null check(revision>0),
 status text not null check(status in ('','planned','in_progress','completed','dropped','seen','paused')), favorite boolean not null,
 progress integer not null default 0 check(progress>=0), progress_unit text not null default '' check(progress_unit in ('','episodes','pages','seconds','percent')),
 rating integer check(rating between 1 and 5), notes text not null, tags text[] not null default '{}',
 check(progress=0 or progress_unit<>''), check(progress_unit<>'percent' or progress<=100)
);
create table library_state_edits (
 item_id text not null references library_items(id), revision bigint not null check(revision>0),
 state jsonb not null, edited_at timestamptz not null default now(), primary key(item_id,revision)
);

create table library_files (
 id text primary key,
 source text not null check(source<>''), account text not null, external_id text not null check(external_id<>''),
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'), filename text not null check(filename<>''), mime_type text not null,
 size_bytes bigint not null check(size_bytes>=0), provenance jsonb not null default '{}', search_text text not null,
 ingested_at timestamptz not null default now(), unique(source,account,external_id)
);
create index library_files_search on library_files using gin(to_tsvector('simple',search_text));
create index library_files_digest on library_files(sha256);
create table library_item_files (
 item_id text not null references library_items(id), file_id text not null references library_files(id),
 primary key(item_id,file_id)
);

create table library_pages (
 id text primary key,
 source text not null check(source<>''), account text not null, external_id text not null check(external_id<>''),
 path text not null check(path<>''), title text not null check(title<>''), body text not null,
 answers text[] not null default '{}', tags text[] not null default '{}', aliases text[] not null default '{}',
 content_hash text not null, revision text not null, sensitivity text not null, provenance jsonb not null default '{}', search_text text not null,
 unique(source,account,external_id)
);
create index library_pages_search on library_pages using gin(to_tsvector('simple',search_text));

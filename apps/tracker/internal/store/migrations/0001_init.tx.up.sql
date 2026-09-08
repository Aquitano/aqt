create table urls (
    id             bigint generated always as identity primary key,
    url_hash       bytea not null unique,
    normalized_url text not null,
    host           text not null,
    created_at     timestamptz not null default now()
);
create index urls_host_idx on urls (host);

create table page_views (
    id              uuid primary key,
    device_id       uuid not null,
    url_id          bigint not null references urls,
    tab_session_id  text,
    title           text,
    started_at      timestamptz not null,
    navigation_type text not null,
    referrer_url_id bigint references urls,
    private         boolean not null default false,
    created_at      timestamptz not null default now()
);
create index page_views_device_started_idx on page_views (device_id, started_at desc);
create index page_views_url_started_idx on page_views (url_id, started_at desc);

create table activity_spans (
    id           uuid primary key,
    device_id    uuid not null,
    page_view_id uuid not null references page_views,
    started_at   timestamptz not null,
    ended_at     timestamptz not null,
    end_reason   text,
    created_at   timestamptz not null default now()
);
create index activity_spans_device_started_idx on activity_spans (device_id, started_at desc);
create index activity_spans_page_view_idx on activity_spans (page_view_id);

create table raw_html_blobs (
    hash         bytea primary key,
    codec        smallint not null,
    raw_bytes    integer not null,
    stored_bytes integer not null,
    payload      bytea not null,
    created_at   timestamptz not null default now()
);
alter table raw_html_blobs alter column payload set storage external;

create table captures (
    id             uuid primary key,
    page_view_id   uuid not null references page_views,
    device_id      uuid not null,
    raw_hash       bytea not null references raw_html_blobs,
    extractor      text not null,
    captured_at    timestamptz not null,
    reason         text not null,
    url            text not null,
    browser_title  text,
    raw_char_count integer,
    created_at     timestamptz not null default now()
);
create index captures_page_view_idx on captures (page_view_id);
create index captures_raw_hash_idx on captures (raw_hash);
create index captures_captured_at_idx on captures (captured_at desc);

create table records (
    id            bigint generated always as identity primary key,
    extractor     text not null,
    record_hash   bytea not null,
    url_id        bigint not null references urls,
    canonical_url text,
    title         text,
    search_text   text not null,
    data          jsonb not null,
    first_seen_at timestamptz not null,
    last_seen_at  timestamptz not null,
    unique (extractor, record_hash)
);
create index records_search on records using bm25 (id, title, search_text, extractor)
    with (key_field = 'id');

create table derivations (
    raw_hash          bytea not null references raw_html_blobs,
    extractor         text not null,
    extractor_version integer not null,
    status            text not null default 'pending',
    attempts          integer not null default 0,
    claimed_at        timestamptz,
    last_error        text,
    error_class       text,
    record_id         bigint references records,
    processing_ms     integer,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    primary key (raw_hash, extractor, extractor_version)
);
create index derivations_queue_idx on derivations (status, created_at) where status in ('pending', 'running');

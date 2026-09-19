create table import_reports (
    id bigint generated always as identity primary key,
    kind text not null,
    input text not null,
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    status text not null default 'running',
    result jsonb not null default '{}',
    error text not null default ''
);
create index import_reports_started_idx on import_reports (id desc);

alter table messages add column parent_external_id text not null default '';
alter table messages add column branch_id text not null default '';
alter table messages add column alternative_index integer not null default 0;
create index messages_parent_idx on messages (source, thread_id, parent_external_id)
    where parent_external_id <> '';

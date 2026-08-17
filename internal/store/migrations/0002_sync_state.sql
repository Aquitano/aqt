create table sync_state (
    source     text primary key,
    state      jsonb not null,
    updated_at timestamptz not null default now()
);

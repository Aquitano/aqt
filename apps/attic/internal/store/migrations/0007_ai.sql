-- Different providers, models and prompt policies keep separate results.
create table ai_results (
    id bigint generated always as identity primary key,
    content_id bigint not null references contents,
    task text not null check (task in ('ocr', 'describe')),
    provider text not null,
    model text not null,
    prompt_version text not null,
    status text not null check (status in ('ok', 'empty', 'truncated', 'failed')),
    text text not null default '',
    detail text not null default '',
    reported_model text not null default '',
    elapsed_ms bigint not null default 0,
    attempts bigint not null default 1,
    updated_at timestamptz not null default now(),
    unique (content_id, task, provider, model, prompt_version)
);
create index ai_results_bm25_idx on ai_results using bm25 (
    id,
    (text::pdb.unicode_words('ascii_folding=true'))
) with (key_field = 'id');
create index ai_results_content_idx on ai_results (content_id);

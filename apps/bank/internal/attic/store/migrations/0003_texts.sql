-- Text read from documents. Like an archive listing it belongs to the
-- content, so a PDF on three disks is read once and found in all three places.
create table texts (
    content_id   bigint primary key references contents,
    -- ok | truncated | empty | needs_ocr | too_big | failed. Truncated text is
    -- the first characters of a document longer than the cap, searchable
    -- like ok.
    status       text not null,
    extractor    text not null default '',
    detail       text not null default '',
    text         text not null default '',
    extracted_at timestamptz not null default now()
);

-- Its own index: document words and file names score on different scales, so
-- search ranks text hits apart. ascii_folding lets "fur" find "für".
create index texts_bm25_idx on texts using bm25 (
    content_id,
    (text::pdb.unicode_words('ascii_folding=true'))
) with (key_field = 'content_id');

-- scans.status gains 'reading', after listing. Skips gain text_failed.
alter table scans
    add column texts      bigint not null default 0,
    add column text_chars bigint not null default 0;

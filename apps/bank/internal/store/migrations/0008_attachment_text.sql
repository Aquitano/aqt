-- Attachment text becomes searchable.
--
-- Extraction is keyed on the blob digest, not on the attachment row: content
-- is addressed by sha256, so the same PDF attached to forty messages is read
-- once and every one of those messages gains its text.
create table blob_text (
    sha256       text primary key,
    text         text not null default '',
    extractor    text not null default '',
    -- ok | empty | needs_ocr | unsupported | too_big | failed | manual.
    -- Kept as text rather than an enum so adding an extractor does not need a
    -- migration, and so a status a newer binary wrote does not break an older
    -- one reading the row.
    status       text not null,
    extracted_at timestamptz not null default now()
);

-- The work queue for `bank extract` is "everything with this status", so the
-- status is the index.
create index blob_text_status_idx on blob_text (status);

-- Denormalized onto the message: one BM25 index means one score, one ranking
-- and working snippets. Two indexes would mean inventing a fusion rule, which
-- is the complexity this archive deliberately avoids. Maintained wholesale by
-- store.RefreshAttachmentText, so there is no trigger to keep in sync.
alter table messages add column attachment_text text not null default '';

drop index messages_bm25_idx;

create index messages_bm25_idx on messages
    using bm25 (id, subject, body, sender, recipients, attachment_text)
    with (key_field = 'id');

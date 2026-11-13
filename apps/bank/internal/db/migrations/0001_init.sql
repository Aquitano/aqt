-- The whole archive: correspondence, contacts, the library, the catalogue of
-- files on disks, and the contents and text they share. DESIGN.md and
-- attic/DESIGN.md explain the identities each part relies on.

-- Contents and text
--
-- Bytes have one identity, their BLAKE3 digest. A message attachment, a
-- library file and a file on a disk with the same bytes share one contents
-- row, and so share what was read from them.

create table contents (
    id         bigint generated always as identity primary key,
    blake3     bytea not null unique check (octet_length(blake3) = 32),
    size_bytes bigint not null check (size_bytes >= 0),
    first_seen timestamptz not null default now()
);

-- A ref is the first eight bytes of the digest, printed as 16 hex characters.
create index contents_ref_idx on contents (substr(blake3, 1, 8));

-- Text read from documents by a disk scan or by `bank extract`, or written
-- by hand. It belongs to the content, so a PDF attached to forty messages and
-- copied to three disks is read once and found in every place. Each reader
-- skips a content that already has a row.
create table texts (
    content_id   bigint primary key references contents,
    -- Truncated text is the first characters of a document longer than the
    -- cap, searchable like ok. No extractor overwrites manual text.
    status       text not null check (status in ('ok', 'truncated', 'empty', 'needs_ocr',
                                                 'unsupported', 'too_big', 'failed', 'manual')),
    extractor    text not null default '',
    detail       text not null default '',
    text         text not null default '',
    extracted_at timestamptz not null default now(),
    -- Sizes are reported from here: length(text) decompresses every stored
    -- text.
    chars        integer generated always as (char_length(text)) stored
);

-- Its own index: document words and file names score on different scales, so
-- search ranks text hits apart. ascii_folding lets "fur" find "für".
create index texts_bm25_idx on texts using bm25 (
    content_id,
    (text::pdb.unicode_words('ascii_folding=true'))
) with (key_field = 'content_id', mutable_segment_rows = 0);

-- Messages and mail

-- id is a row number for joins and changes when the archive is rebuilt; ref is
-- what a citation carries. ref.ForMessage derives it from the source and the
-- identifier that keys the message, and InsertMessages writes it.
create table messages (
    id                 bigint generated always as identity primary key,
    ref                text not null unique check (ref ~ '^msg:[0-9a-f]{16}$'),
    source             text not null,
    external_id        text not null,
    thread_id          text not null default '',
    sender             text not null default '',
    recipients         text[] not null default '{}',
    subject            text not null default '',
    body               text not null default '',
    sent_at            timestamptz not null,
    raw_ref            text not null default '',
    ingested_at        timestamptz not null default now(),
    -- RFC 822 Message-ID, stored separately from external_id so mail that
    -- arrives twice under different id schemes (Gmail API id vs Takeout mbox)
    -- still dedups.
    message_id         text not null default '',
    -- Text read out of the message's attachments, denormalized so one BM25
    -- index gives one score, one ranking and working snippets. Two indexes
    -- would need a fusion rule. store.RefreshAttachmentText maintains it
    -- wholesale, so there is no trigger to keep in sync.
    attachment_text    text not null default '',
    parent_external_id text not null default '',
    branch_id          text not null default '',
    alternative_index  integer not null default 0,
    unique (source, external_id)
);

create index messages_sent_at_idx on messages (sent_at);
-- Message-ID dedup is structural because a check-then-insert races under the
-- sync's concurrent workers. InsertMessage uses a bare "on conflict do
-- nothing", so a violation skips silently.
create unique index messages_source_message_id_key
    on messages (source, message_id) where message_id <> '';
-- `bank thread <id>` reads one conversation in chronological order.
create index messages_thread_idx on messages (thread_id, sent_at, id);
create index messages_source_thread_page_idx on messages (source, thread_id, sent_at, id);
create index messages_parent_idx on messages (source, thread_id, parent_external_id)
    where parent_external_id <> '';

-- Recipients are indexed because "who did I send that to" is as common a
-- question as "who sent me that", and the --to filter needs recipient text to
-- contribute to matching and ranking, not only to post-filtering.
create index messages_bm25_idx on messages
    using bm25 (id, subject, body, sender, recipients, attachment_text)
    with (key_field = 'id');

create table attachments (
    id          bigint generated always as identity primary key,
    message_id  bigint not null references messages (id) on delete cascade,
    filename    text not null,
    mime_type   text not null default '',
    content_id  bigint not null references contents,
    ingested_at timestamptz default clock_timestamp()
);

create index attachments_message_id_idx on attachments (message_id);
create index attachments_content_idx on attachments (content_id);

-- A retired message keeps its identity here after its row is deleted: imports
-- skip a tombstoned (source, external_id) or (source, message_id), and its ref
-- still resolves to what it was and to the record that replaced it.
create table message_tombstones (
    source      text not null,
    external_id text not null,
    message_id  text not null default '',
    ref         text not null unique check (ref ~ '^msg:[0-9a-f]{16}$'),
    sent_at     timestamptz not null,
    subject     text not null default '',
    raw_ref     text not null default '',
    reason      text not null default '',
    replacement text not null default '',
    retired_at  timestamptz not null default now(),
    primary key (source, external_id)
);
create index message_tombstones_message_id on message_tombstones (source, message_id)
    where message_id <> '';

create table sync_state (
    source     text primary key,
    state      jsonb not null,
    updated_at timestamptz not null default now()
);

create table import_reports (
    id          bigint generated always as identity primary key,
    kind        text not null,
    input       text not null,
    started_at  timestamptz not null default now(),
    finished_at timestamptz,
    status      text not null default 'running',
    result      jsonb not null default '{}',
    error       text not null default ''
);

create table mailboxes (
    id     bigint generated always as identity primary key,
    source text not null,
    kind   text not null check (kind in ('export', 'imap')),
    path   text not null,
    unique (source, kind, path)
);

create table mailbox_messages (
    mailbox_id bigint not null references mailboxes (id) on delete cascade,
    message_id bigint not null references messages (id) on delete cascade,
    primary key (mailbox_id, message_id)
);
create index mailbox_messages_message on mailbox_messages (message_id);

create table mail_thread_nodes (
    source       text not null,
    node_key     text not null,
    thread_id    text not null default '',
    conflict_key text not null default '',
    primary key (source, node_key)
);

create table mail_details (
    message_id        bigint primary key references messages (id) on delete cascade,
    source            text not null,
    node_key          text not null,
    in_reply_to       text[] not null default '{}',
    reference_ids     text[] not null default '{}',
    native_thread_id  text not null default '',
    incomplete        boolean not null default false,
    header_message_id text not null default '',
    header_raw_ref    text not null default '',
    foreign key (source, node_key) references mail_thread_nodes (source, node_key)
);
create index mail_details_node on mail_details (source, node_key);
create index mail_details_native on mail_details (source, native_thread_id) where native_thread_id <> '';

create table mail_thread_edges (
    source     text not null,
    owner_id   bigint not null references messages (id) on delete cascade,
    left_node  text not null,
    right_node text not null,
    primary key (source, owner_id, left_node, right_node),
    foreign key (source, left_node) references mail_thread_nodes (source, node_key),
    foreign key (source, right_node) references mail_thread_nodes (source, node_key)
);
create index mail_thread_edges_left on mail_thread_edges (source, left_node);
create index mail_thread_edges_right on mail_thread_edges (source, right_node);
create index mail_thread_edges_owner on mail_thread_edges (owner_id);

create table mail_thread_conflicts (
    source       text not null,
    conflict_key text not null,
    node_keys    text[] not null,
    primary key (source, conflict_key)
);
create index mail_thread_conflicts_nodes on mail_thread_conflicts using gin (node_keys);

create table mail_thread_aliases (
    source       text not null,
    old_id       text not null,
    current_id   text,
    conflict_key text,
    primary key (source, old_id),
    check ((current_id is null) <> (conflict_key is null))
);
create index mail_thread_aliases_conflict on mail_thread_aliases (source, conflict_key);
create index mail_thread_aliases_old on mail_thread_aliases (old_id);

create table mail_rebuild_progress (
    source       text not null,
    work_key     text not null,
    completed_at timestamptz not null default now(),
    primary key (source, work_key)
);

-- Contacts
--
-- One person, many source-specific identities. The archive stores whatever
-- each source called someone; a contact is the owner's own name for them, and
-- aliases are the strings that mean that person. Nothing here ever rewrites a
-- message: the identity a source recorded stays exactly as it arrived, and
-- detaching an alias undoes a wrong attribution completely.

-- Case, surrounding space and irregular inner spacing are formatting, not
-- identity: fold them away before anything is compared.
create function bank_identity_fold(v text) returns text
    language sql immutable parallel safe
as $fn$
    select btrim(regexp_replace(lower(v), '\s+', ' ', 'g'))
$fn$;

-- Every form a sender or recipient string can be recognised by: the whole
-- value, the bracketed address, and the display name with the address removed.
-- Lowercased, trimmed and whitespace-collapsed, so a match never depends on
-- how one source chose to format a name.
create function bank_identity_keys(v text) returns text[]
    language sql immutable parallel safe strict
as $fn$
    select coalesce(array_agg(distinct k), '{}'::text[])
    from (select unnest(array[
              bank_identity_fold(v),
              bank_identity_fold(substring(v from '<([^<>]+)>')),
              bank_identity_fold(regexp_replace(v, '<[^<>]*>', '', 'g'))
          ]) as k) t
    where k is not null and k <> ''
$fn$;

-- The single most specific form: the address when there is one, otherwise the
-- display name. This is what an alias is stored as, and what `contact suggest`
-- proposes, so both sides of a match agree on one spelling.
create function bank_identity_key(v text) returns text
    language sql immutable parallel safe strict
as $fn$
    select coalesce(nullif(bank_identity_fold(substring(v from '<([^<>]+)>')), ''),
                    bank_identity_fold(v))
$fn$;

create table contacts (
    id         bigint generated always as identity primary key,
    name       text not null unique,
    note       text not null default '',
    created_at timestamptz not null default now()
);

create table contact_aliases (
    id         bigint generated always as identity primary key,
    contact_id bigint not null references contacts (id) on delete cascade,
    -- '' matches in every source. A source name narrows the alias to it, for
    -- the case where one display name means two people in two places.
    source     text not null default '',
    -- value is what the owner typed, kept verbatim so a correction is
    -- reviewable; value_norm is the only thing matching compares.
    value      text not null,
    value_norm text not null,
    created_at timestamptz not null default now(),
    -- One spelling means one person within a scope. Overlaps across scopes are
    -- rejected in Go, where the other contact's name can be named in the error.
    unique (source, value_norm)
);

create index contact_aliases_contact_idx on contact_aliases (contact_id);
create index contact_aliases_norm_idx on contact_aliases (value_norm);

-- Library

-- Valid page and note text can exceed PostgreSQL's 1 MiB vector limit.
create function blob_text_search_vector(document text) returns tsvector
language plpgsql immutable parallel safe as $$
begin
    return to_tsvector('simple',document);
exception when program_limit_exceeded then
    return null;
end
$$;

-- Overflowed documents retain query terms with the native position and occurrence caps.
create function blob_text_query_vector(document text,query text) returns tsvector
language sql stable parallel safe as $$
    with terms as (
        select tsvector_to_array(to_tsvector('simple',query)) lexemes
    ), tokens as (
        select lexeme,least(row_number() over(order by parsed.ordinality,emitted.lexeme_order),16383) position
        from ts_debug('simple',document) with ordinality parsed
        cross join lateral unnest(parsed.lexemes) with ordinality emitted(lexeme,lexeme_order)
        where octet_length(lexeme)<=2047
    ), selected as (
        select distinct lexeme,position from tokens,terms
        where lexeme=any(terms.lexemes)
    ), ranked as (
        select lexeme,position,row_number() over(partition by lexeme order by position) rank
        from selected
    ), vectors as (
        select '''' || replace(replace(lexeme,chr(92),chr(92)||chr(92)),'''','''''') || ''':' ||
            string_agg(position::text,',' order by position) value
        from ranked where rank<=256 group by lexeme
    )
    select coalesce(string_agg(value,' '),'')::tsvector from vectors
$$;

create table library_items (
    id               text primary key,
    source           text not null check (source <> ''),
    account          text not null,
    external_id      text not null check (external_id <> ''),
    kind             text not null check (kind in ('video', 'movie', 'series', 'episode', 'track', 'album', 'podcast', 'book', 'article', 'other')),
    title            text not null check (title <> ''),
    description      text not null default '',
    url              text not null default '',
    provider         text not null default '',
    provider_id      text not null default '',
    creators         text[] not null default '{}',
    series           text not null default '',
    album            text not null default '',
    year             integer check (year between 1 and 9999),
    season           integer check (season >= 0),
    episode          integer check (episode >= 0),
    duration_seconds integer check (duration_seconds >= 0),
    provenance       jsonb not null default '{}',
    search_text      text not null,
    unique (source, account, external_id),
    check ((provider = '') = (provider_id = ''))
);
create index library_items_search on library_items using gin (to_tsvector('simple', search_text));
create index library_items_provider on library_items (provider, provider_id) where provider_id <> '';

create table library_item_evidence (
    item_id text not null references library_items (id),
    raw_ref text not null check (raw_ref <> ''),
    locator text not null default '',
    primary key (item_id, raw_ref, locator)
);

create table library_activity (
    id               text primary key,
    source           text not null check (source <> ''),
    account          text not null,
    external_id      text not null check (external_id <> ''),
    item_id          text not null references library_items (id),
    kind             text not null check (kind in ('watch', 'listen', 'read', 'play', 'view', 'purchase', 'other')),
    title            text not null default '',
    occurred         jsonb not null,
    duration_seconds integer check (duration_seconds >= 0),
    provenance       jsonb not null default '{}',
    search_text      text not null,
    unique (source, account, external_id),
    check (occurred->>'precision' in ('unknown', 'day', 'instant')),
    check (((occurred->>'precision') = 'unknown') = ((occurred->>'value') = ''))
);
create index library_activity_search on library_activity using gin (to_tsvector('simple', search_text));
create index library_activity_item on library_activity (item_id);
create index library_activity_legacy_netflix on library_activity (source, account, item_id)
    where kind = 'watch' and external_id ~ '^file:[0-9a-f]{64}:row:[0-9]+$';

create table library_activity_evidence (
    activity_id text not null references library_activity (id),
    raw_ref     text not null check (raw_ref <> ''),
    locator     text not null default '',
    primary key (activity_id, raw_ref, locator)
);

create table library_activity_aliases (
    id          text primary key,
    activity_id text not null references library_activity (id)
);
create index library_activity_aliases_activity on library_activity_aliases (activity_id);

create table library_collections (
    id          text primary key,
    source      text not null check (source <> ''),
    account     text not null,
    external_id text not null check (external_id <> ''),
    kind        text not null check (kind in ('playlist', 'library', 'watchlist', 'list')),
    title       text not null check (title <> ''),
    description text not null default '',
    personal    boolean not null default false,
    revision    bigint not null default 0 check (revision >= 0),
    search_text text not null,
    unique (source, account, external_id)
);
create index library_collections_search on library_collections using gin (to_tsvector('simple', search_text));

create table library_snapshots (
    id            bigint generated always as identity primary key,
    collection_id text not null references library_collections (id),
    external_id   text not null check (external_id <> ''),
    captured      jsonb not null,
    completeness  text not null check (completeness in ('complete', 'partial', 'unknown')),
    provenance    jsonb not null default '{}',
    unique (collection_id, external_id),
    check (captured->>'precision' in ('unknown', 'day', 'instant')),
    check (((captured->>'precision') = 'unknown') = ((captured->>'value') = ''))
);

create table library_entries (
    snapshot_id bigint not null references library_snapshots (id),
    position    integer not null check (position >= 0),
    item_id     text not null references library_items (id),
    external_id text not null default '',
    added       jsonb not null,
    primary key (snapshot_id, position),
    check (added->>'precision' in ('unknown', 'day', 'instant')),
    check (((added->>'precision') = 'unknown') = ((added->>'value') = ''))
);

create table library_collection_edits (
    collection_id text not null references library_collections (id),
    revision      bigint not null check (revision > 0),
    title         text not null,
    description   text not null,
    snapshot_id   bigint not null references library_snapshots (id),
    edited_at     timestamptz not null default now(),
    primary key (collection_id, revision)
);

create table library_state (
    item_id       text primary key references library_items (id),
    revision      bigint not null check (revision > 0),
    status        text not null check (status in ('', 'planned', 'in_progress', 'completed', 'dropped', 'seen', 'paused')),
    favorite      boolean not null,
    progress      integer not null default 0 check (progress >= 0),
    progress_unit text not null default '' check (progress_unit in ('', 'episodes', 'pages', 'seconds', 'percent')),
    rating        integer check (rating between 1 and 5),
    notes         text not null,
    tags          text[] not null default '{}',
    check (progress = 0 or progress_unit <> ''),
    check (progress_unit <> 'percent' or progress <= 100)
);

create table library_state_edits (
    item_id   text not null references library_items (id),
    revision  bigint not null check (revision > 0),
    state     jsonb not null,
    edited_at timestamptz not null default now(),
    primary key (item_id, revision)
);

create table library_files (
    id          text primary key,
    source      text not null check (source <> ''),
    account     text not null,
    external_id text not null check (external_id <> ''),
    content_id  bigint not null references contents,
    filename    text not null check (filename <> ''),
    mime_type   text not null,
    provenance  jsonb not null default '{}',
    search_text text not null,
    ingested_at timestamptz not null default now(),
    unique (source, account, external_id)
);
create index library_files_search on library_files using gin (to_tsvector('simple', search_text));
create index library_files_content on library_files (content_id);

create table library_item_files (
    item_id text not null references library_items (id),
    file_id text not null references library_files (id),
    primary key (item_id, file_id)
);

create table library_pages (
    id            text primary key,
    source        text not null check (source <> ''),
    account       text not null,
    external_id   text not null check (external_id <> ''),
    path          text not null check (path <> ''),
    title         text not null check (title <> ''),
    body          text not null,
    answers       text[] not null default '{}',
    tags          text[] not null default '{}',
    aliases       text[] not null default '{}',
    content_hash  text not null,
    revision      text not null,
    sensitivity   text not null,
    provenance    jsonb not null default '{}',
    search_text   text not null,
    search_vector tsvector generated always as (blob_text_search_vector(search_text)) stored,
    unique (source, account, external_id)
);
create index library_pages_search on library_pages using gin (search_vector);
create index library_pages_oversized_search on library_pages (id) where search_vector is null;

-- Disks
--
-- The catalogue of files on disks that come and go. attic/DESIGN.md explains
-- its three identities: volumes by fingerprint, contents by BLAKE3 (defined
-- above, shared with the archive), entries by NTFS file id or by path.
--
-- Every BM25 index here sets mutable_segment_rows = 0, so new rows go straight
-- into immutable segments: mutable segments buffer writes at the cost of
-- search speed.

create table volumes (
    id            uuid primary key default gen_random_uuid(),
    label         text not null default '',
    fs_type       text not null,
    serial        text not null,
    partition_id  text not null default '',
    device_serial text not null default '',
    size_bytes    bigint not null default 0,
    stable_ids    boolean not null,
    -- Where the volume was last mounted, for display only.
    mount_path    text not null default '',
    first_seen    timestamptz not null default now(),
    last_seen     timestamptz not null default now()
);

create index volumes_serial_idx on volumes (fs_type, serial);

create table scans (
    id           bigint generated always as identity primary key,
    volume_id    uuid not null references volumes,
    -- The scanned folder, volume-relative like entries.path.
    root         text not null,
    -- walking | hashing | listing | reading | metadata | complete |
    -- interrupted | failed
    status       text not null,
    started_at   timestamptz not null default now(),
    finished_at  timestamptz,
    listed       bigint not null default 0,
    written      bigint not null default 0,
    missing      bigint not null default 0,
    skipped      bigint not null default 0,
    hashed       bigint not null default 0,
    hashed_bytes bigint not null default 0,
    duplicates   bigint not null default 0,
    error        text not null default '',
    archives     bigint not null default 0,
    members      bigint not null default 0,
    texts        bigint not null default 0,
    text_chars   bigint not null default 0,
    -- How long each phase took, so a slow disk, archive or document stage
    -- shows in the scan history and not only in its log.
    walk_ms      bigint not null default 0,
    hash_ms      bigint not null default 0,
    archives_ms  bigint not null default 0,
    text_ms      bigint not null default 0,
    metadata     bigint not null default 0,
    metadata_ms  bigint not null default 0
);

create table entries (
    id               bigint generated always as identity primary key,
    volume_id        uuid not null references volumes,
    parent_id        bigint references entries,
    -- dir | file | link
    kind             text not null,
    name             text not null,
    -- Volume-relative and '/'-separated: '' is the root, '/Files/x.zip' a file.
    -- Stored on every row because search ranks path words with the name.
    path             text not null,
    ext              text not null default '',
    -- The NTFS file reference number. Null on file systems without stable ids,
    -- where the path is the identity instead.
    file_id          bigint,
    size_bytes       bigint not null default 0,
    created_at       timestamptz,
    modified_at      timestamptz,
    accessed_at      timestamptz,
    changed_at       timestamptz,
    attributes       integer not null default 0,
    content_id       bigint references contents,
    -- Files: pending | done | skipped | failed. Folders and links: none.
    hash_state       text not null,
    git_remote       text,
    -- Set when a complete listing of the parent folder no longer found it.
    missing_scan     bigint references scans,
    -- Folders: the last scan that read this folder completely.
    listed_scan      bigint references scans,
    first_scan       bigint not null references scans,
    updated_scan     bigint not null references scans,
    raw_name         bytea not null,
    physical_file_id bigint,
    hash_trusted     boolean not null default false
) with (fillfactor = 80);
-- The fill factor leaves room on each page, so rewriting accessed_at or
-- listed_scan stays a heap-only update and does not touch the BM25 index.

create unique index entries_file_id_idx on entries (volume_id, file_id) where file_id is not null;
create unique index entries_path_identity_idx on entries (parent_id, raw_name) where file_id is null;
create unique index entries_root_idx on entries (volume_id) where parent_id is null;
create index entries_parent_idx on entries (parent_id);
create index entries_content_idx on entries (content_id);
-- Byte order makes a subtree a range: everything under P sorts between
-- P || '/' and P || '0', the next character after '/'.
create index entries_path_idx on entries (volume_id, path collate "C");
create index entries_hash_queue_idx on entries (volume_id, path collate "C")
    where hash_state in ('pending', 'failed');
create index entries_physical_file_idx on entries (volume_id, physical_file_id)
    where physical_file_id is not null;
create index entries_missing_scan_idx on entries (missing_scan) where missing_scan is not null;
-- The timeline lists present files by modification time.
create index entries_modified_idx on entries (modified_at, id)
    where kind = 'file' and missing_scan is null and modified_at is not null;

-- source_code splits MinecraftServer and pingpong_final into words; the
-- trigram field finds fragments such as "werkstudent" inside
-- Werkstudentenvertrag. ascii_folding lets "fur" find "für". Volume, kind and
-- extension are indexed so their filters run inside the BM25 scan; as heap
-- filters they would read every matching row before the top hits are known.
create index entries_bm25_idx on entries using bm25 (
    id,
    (name::pdb.source_code('ascii_folding=true')),
    (name::pdb.ngram(3, 3, 'alias=name_ngram', 'ascii_folding=true')),
    (path::pdb.source_code('ascii_folding=true')),
    volume_id,
    (kind::pdb.literal),
    (ext::pdb.literal)
) with (key_field = 'id', mutable_segment_rows = 0);

-- Which contents an entry held, so what was read from earlier bytes stays
-- searchable after the file changes. The open row is the content the entry
-- holds now; replaced_scan is the scan that saw the bytes change.
create table entry_versions (
    id            bigint generated always as identity primary key,
    entry_id      bigint not null references entries,
    content_id    bigint not null references contents,
    size_bytes    bigint not null,
    modified_at   timestamptz,
    first_scan    bigint not null references scans,
    replaced_scan bigint references scans
);

create unique index entry_versions_open_idx on entry_versions (entry_id) where replaced_scan is null;
create index entry_versions_entry_idx on entry_versions (entry_id, id);
create index entry_versions_content_idx on entry_versions (content_id);

create table skips (
    id      bigint generated always as identity primary key,
    scan_id bigint not null references scans on delete cascade,
    -- A skip inside an archive has a path with ' :: '.
    path    text not null,
    -- excluded | name_only | too_big | link | remote | unreadable | changed |
    -- too_deep | encrypted | damaged | not_archive | split | text_failed |
    -- metadata_failed | metadata_unavailable
    reason  text not null,
    rule    text not null default '',
    detail  text not null default ''
);

create index skips_scan_idx on skips (scan_id, reason);

-- What archives hold. A listing belongs to the archive's content, so the same
-- zip on three disks is read once and a hit inside it shows all three copies.
create table archives (
    content_id bigint primary key references contents,
    -- zip | 7z | rar | tar | tar.gz ...; empty when the bytes are no archive.
    format     text not null default '',
    -- listed | damaged | encrypted | not_archive | split. A damaged archive
    -- keeps the members read before the damage.
    status     text not null,
    detail     text not null default '',
    members    bigint not null default 0,
    listed_at  timestamptz not null default now(),
    depth      integer check (depth >= 0)
);

-- Members are never hashed: their bytes are only read to open nested archives.
create table members (
    id          bigint generated always as identity primary key,
    archive_id  bigint not null references archives,
    -- dir | file | link
    kind        text not null,
    name        text not null,
    -- Inside the archive and '/'-separated; ' :: ' steps into a nested archive.
    path        text not null,
    ext         text not null default '',
    size_bytes  bigint not null default 0,
    modified_at timestamptz,
    crc32       bigint,
    encrypted   boolean not null default false
);

create index members_archive_idx on members (archive_id);

-- The same fields as entries_bm25_idx, so one query builder serves both.
create index members_bm25_idx on members using bm25 (
    id,
    (name::pdb.source_code('ascii_folding=true')),
    (name::pdb.ngram(3, 3, 'alias=name_ngram', 'ascii_folding=true')),
    (path::pdb.source_code('ascii_folding=true'))
) with (key_field = 'id', mutable_segment_rows = 0);

create table archive_depth_failures (
    content_id       bigint not null references archives on delete cascade,
    depth            integer not null check (depth > 0),
    unpack_max_bytes bigint not null check (unpack_max_bytes >= 0),
    primary key (content_id, depth, unpack_max_bytes)
);

create table metadata (
    content_id   bigint primary key references contents,
    status       text not null,
    detail       text not null default '',
    tags         jsonb not null,
    text         text not null default '',
    extracted_at timestamptz not null default now()
);
create index metadata_bm25_idx on metadata using bm25 (
    content_id,
    (text::pdb.unicode_words('ascii_folding=true'))
) with (key_field = 'content_id', mutable_segment_rows = 0);

-- Different providers, models and prompt policies keep separate results.
create table ai_results (
    id             bigint generated always as identity primary key,
    content_id     bigint not null references contents,
    task           text not null check (task in ('ocr', 'describe')),
    provider       text not null,
    model          text not null,
    prompt_version text not null,
    status         text not null check (status in ('ok', 'empty', 'truncated', 'failed')),
    text           text not null default '',
    detail         text not null default '',
    reported_model text not null default '',
    elapsed_ms     bigint not null default 0,
    attempts       bigint not null default 1,
    updated_at     timestamptz not null default now(),
    unique (content_id, task, provider, model, prompt_version)
);
create index ai_results_bm25_idx on ai_results using bm25 (
    id,
    (text::pdb.unicode_words('ascii_folding=true'))
) with (key_field = 'id', mutable_segment_rows = 0);
create index ai_results_content_idx on ai_results (content_id);

-- A copy dedupe moved into its disk's quarantine folder. The entry stays, so
-- the catalogue still says where the copy was and which copy was kept.
create table dedupe_moves (
    entry_id      bigint primary key references entries,
    kept_entry_id bigint not null references entries,
    content_id    bigint not null references contents,
    moved_to      text not null,
    moved_at      timestamptz not null default now()
);

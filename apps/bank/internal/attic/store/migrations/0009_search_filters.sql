-- Volume, kind and extension filters run inside the BM25 scan. As heap
-- filters they read every matching row before the top hits are known.
drop index entries_bm25_idx;
create index entries_bm25_idx on entries using bm25 (
    id,
    (name::pdb.source_code('ascii_folding=true')),
    (name::pdb.ngram(3, 3, 'alias=name_ngram', 'ascii_folding=true')),
    (path::pdb.source_code('ascii_folding=true')),
    volume_id,
    (kind::pdb.literal),
    (ext::pdb.literal)
) with (key_field = 'id');

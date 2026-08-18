-- Recipients belong in the BM25 index: "who did I send that to" is as common
-- a question as "who sent me that", and the --to filter needs the recipient
-- text to contribute to matching and ranking, not just to post-filtering.
drop index messages_bm25_idx;

create index messages_bm25_idx on messages
    using bm25 (id, subject, body, sender, recipients)
    with (key_field = 'id');

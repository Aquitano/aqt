alter index entries_bm25_idx set (mutable_segment_rows = 0);
alter index members_bm25_idx set (mutable_segment_rows = 0);
alter index texts_bm25_idx set (mutable_segment_rows = 0);
alter index metadata_bm25_idx set (mutable_segment_rows = 0);
alter index ai_results_bm25_idx set (mutable_segment_rows = 0);

reindex index entries_bm25_idx;
reindex index members_bm25_idx;
reindex index texts_bm25_idx;
reindex index metadata_bm25_idx;
reindex index ai_results_bm25_idx;

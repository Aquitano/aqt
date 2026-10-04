drop index library_pages_search;
alter table library_pages add column search_vector tsvector
generated always as (blob_text_search_vector(search_text)) stored;
create index library_pages_search on library_pages using gin(search_vector);
create index library_pages_oversized_search on library_pages(id)
where search_vector is null;

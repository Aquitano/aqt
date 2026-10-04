-- Valid extracted text can exceed PostgreSQL's 1 MiB vector limit.
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

alter table blob_text add column search_vector tsvector
generated always as (blob_text_search_vector(text)) stored;
create index blob_text_search on blob_text using gin(search_vector)
where status in ('ok','manual');
create index blob_text_oversized_search on blob_text(sha256)
where search_vector is null and status in ('ok','manual');

create table library_item_evidence (
    item_id text not null references library_items(id),
    raw_ref text not null check(raw_ref <> ''),
    locator text not null default '',
    primary key(item_id,raw_ref,locator)
);
insert into library_item_evidence(item_id,raw_ref,locator)
select id,provenance->>'raw_ref',coalesce(provenance->>'locator','')
from library_items where coalesce(provenance->>'raw_ref','')<>'';

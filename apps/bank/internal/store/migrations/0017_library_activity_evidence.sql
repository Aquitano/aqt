create table library_activity_evidence (
    activity_id text not null references library_activity(id),
    raw_ref text not null check(raw_ref <> ''),
    locator text not null default '',
    primary key(activity_id,raw_ref,locator)
);
insert into library_activity_evidence(activity_id,raw_ref,locator)
select id,provenance->>'raw_ref',coalesce(provenance->>'locator','')
from library_activity where coalesce(provenance->>'raw_ref','')<>'';

create table library_activity_aliases (
    id text primary key,
    activity_id text not null references library_activity(id)
);
create index library_activity_aliases_activity on library_activity_aliases(activity_id);

create index library_activity_legacy_netflix on library_activity(source,account,item_id)
where kind='watch' and external_id ~ '^file:[0-9a-f]{64}:row:[0-9]+$';

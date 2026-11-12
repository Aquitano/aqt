alter table entries add column raw_name bytea;
update entries set raw_name = convert_to(name, 'UTF8');
alter table entries alter column raw_name set not null;

drop index entries_path_identity_idx;
create unique index entries_path_identity_idx on entries (parent_id, raw_name) where file_id is null;

alter table entries add column physical_file_id bigint;
update entries set physical_file_id = file_id where file_id is not null;
create index entries_physical_file_idx on entries (volume_id, physical_file_id)
    where physical_file_id is not null;

with recursive below as (
    select e.id, p.updated_scan as missing_scan
    from entries e join entries p on e.parent_id = p.id
    where p.kind <> 'dir'
    union
    select e.id, b.missing_scan from entries e join below b on e.parent_id = b.id
)
update entries e set missing_scan = b.missing_scan
from (select id, max(missing_scan) as missing_scan from below group by id) b
where e.id = b.id and e.missing_scan is null;

create index entries_missing_scan_idx on entries (missing_scan) where missing_scan is not null;

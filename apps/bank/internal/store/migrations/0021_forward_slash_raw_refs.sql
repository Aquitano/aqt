-- Windows imports stored refs like 'mail\x.eml'. A backslash ref is rewritten
-- only when it has no '/', because every ref written on Linux has one after
-- its source directory, and a Linux filename may itself contain a backslash.
-- strpos is used because backslash is LIKE's escape character.
update messages set raw_ref=replace(raw_ref,'\','/')
where strpos(raw_ref,'\')>0 and strpos(raw_ref,'/')=0;

update message_id_collapsed set raw_ref=replace(raw_ref,'\','/')
where strpos(raw_ref,'\')>0 and strpos(raw_ref,'/')=0;

update mail_details set header_raw_ref=replace(header_raw_ref,'\','/')
where strpos(header_raw_ref,'\')>0 and strpos(header_raw_ref,'/')=0;

-- Library 'input:' refs are placeholders named after an input's base name, so
-- a backslash in one is part of the name. Evidence rows already present under
-- the forward-slash ref record the same evidence, so the backslash copy is
-- dropped instead of colliding with the primary key.
delete from library_item_evidence e
where strpos(e.raw_ref,'\')>0 and strpos(e.raw_ref,'/')=0 and e.raw_ref not like 'input:%'
  and exists (select 1 from library_item_evidence f
              where f.item_id=e.item_id and f.locator=e.locator and f.raw_ref=replace(e.raw_ref,'\','/'));
update library_item_evidence set raw_ref=replace(raw_ref,'\','/')
where strpos(raw_ref,'\')>0 and strpos(raw_ref,'/')=0 and raw_ref not like 'input:%';

delete from library_activity_evidence e
where strpos(e.raw_ref,'\')>0 and strpos(e.raw_ref,'/')=0 and e.raw_ref not like 'input:%'
  and exists (select 1 from library_activity_evidence f
              where f.activity_id=e.activity_id and f.locator=e.locator and f.raw_ref=replace(e.raw_ref,'\','/'));
update library_activity_evidence set raw_ref=replace(raw_ref,'\','/')
where strpos(raw_ref,'\')>0 and strpos(raw_ref,'/')=0 and raw_ref not like 'input:%';

update library_items set provenance=jsonb_set(provenance,'{raw_ref}',to_jsonb(replace(provenance->>'raw_ref','\','/')))
where strpos(provenance->>'raw_ref','\')>0 and strpos(provenance->>'raw_ref','/')=0 and provenance->>'raw_ref' not like 'input:%';

update library_activity set provenance=jsonb_set(provenance,'{raw_ref}',to_jsonb(replace(provenance->>'raw_ref','\','/')))
where strpos(provenance->>'raw_ref','\')>0 and strpos(provenance->>'raw_ref','/')=0 and provenance->>'raw_ref' not like 'input:%';

update library_snapshots set provenance=jsonb_set(provenance,'{raw_ref}',to_jsonb(replace(provenance->>'raw_ref','\','/')))
where strpos(provenance->>'raw_ref','\')>0 and strpos(provenance->>'raw_ref','/')=0 and provenance->>'raw_ref' not like 'input:%';

update library_files set provenance=jsonb_set(provenance,'{raw_ref}',to_jsonb(replace(provenance->>'raw_ref','\','/')))
where strpos(provenance->>'raw_ref','\')>0 and strpos(provenance->>'raw_ref','/')=0 and provenance->>'raw_ref' not like 'input:%';

update library_pages set provenance=jsonb_set(provenance,'{raw_ref}',to_jsonb(replace(provenance->>'raw_ref','\','/')))
where strpos(provenance->>'raw_ref','\')>0 and strpos(provenance->>'raw_ref','/')=0 and provenance->>'raw_ref' not like 'input:%';

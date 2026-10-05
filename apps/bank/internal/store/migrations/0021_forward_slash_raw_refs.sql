-- Windows imports stored refs like 'mail\x.eml'. A backslash ref is rewritten
-- only when it has no '/', because every ref written on Linux has one after
-- its source directory, and a Linux filename may itself contain a backslash.
-- strpos is used because backslash is LIKE's escape character.
--
-- Library refs are left alone: the library importer never wrote backslash
-- refs, and bundles may name their own refs, where a backslash belongs to the
-- filename.
update messages set raw_ref=replace(raw_ref,'\','/')
where strpos(raw_ref,'\')>0 and strpos(raw_ref,'/')=0;

update message_id_collapsed set raw_ref=replace(raw_ref,'\','/')
where strpos(raw_ref,'\')>0 and strpos(raw_ref,'/')=0;

update mail_details set header_raw_ref=replace(header_raw_ref,'\','/')
where strpos(header_raw_ref,'\')>0 and strpos(header_raw_ref,'/')=0;

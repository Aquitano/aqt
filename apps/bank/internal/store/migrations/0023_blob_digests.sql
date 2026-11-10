-- attic identifies a file's bytes by BLAKE3. Recording that digest for the
-- blobs bank stores under SHA-256 matches a message attachment or a library
-- file to its copies on disks.
create table blob_digests (
    sha256 text primary key,
    blake3 bytea not null check (octet_length(blake3) = 32)
);
create index blob_digests_blake3 on blob_digests (blake3);

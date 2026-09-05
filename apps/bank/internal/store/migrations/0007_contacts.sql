-- One person, many source-specific identities. The archive stores whatever
-- each source called someone; a contact is the owner's own name for them, and
-- aliases are the strings that mean that person. Nothing here ever rewrites a
-- message: the identity a source recorded stays exactly as it arrived, and
-- detaching an alias undoes a wrong attribution completely.

-- Case, surrounding space and irregular inner spacing are formatting, not
-- identity: fold them away before anything is compared.
create function bank_identity_fold(v text) returns text
    language sql immutable parallel safe
as $fn$
    select btrim(regexp_replace(lower(v), '\s+', ' ', 'g'))
$fn$;

-- Every form a sender or recipient string can be recognised by: the whole
-- value, the bracketed address, and the display name with the address removed.
-- Lowercased, trimmed and whitespace-collapsed, so a match never depends on
-- how one source chose to format a name.
create function bank_identity_keys(v text) returns text[]
    language sql immutable parallel safe strict
as $fn$
    select coalesce(array_agg(distinct k), '{}'::text[])
    from (select unnest(array[
              bank_identity_fold(v),
              bank_identity_fold(substring(v from '<([^<>]+)>')),
              bank_identity_fold(regexp_replace(v, '<[^<>]*>', '', 'g'))
          ]) as k) t
    where k is not null and k <> ''
$fn$;

-- The single most specific form: the address when there is one, otherwise the
-- display name. This is what an alias is stored as, and what `contact suggest`
-- proposes, so both sides of a match agree on one spelling.
create function bank_identity_key(v text) returns text
    language sql immutable parallel safe strict
as $fn$
    select coalesce(nullif(bank_identity_fold(substring(v from '<([^<>]+)>')), ''),
                    bank_identity_fold(v))
$fn$;

create table contacts (
    id         bigint generated always as identity primary key,
    name       text not null unique,
    note       text not null default '',
    created_at timestamptz not null default now()
);

create table contact_aliases (
    id         bigint generated always as identity primary key,
    contact_id bigint not null references contacts (id) on delete cascade,
    -- '' matches in every source. A source name narrows the alias to it, for
    -- the case where one display name means two people in two places.
    source     text not null default '',
    -- value is what the owner typed, kept verbatim so a correction is
    -- reviewable; value_norm is the only thing matching compares.
    value      text not null,
    value_norm text not null,
    created_at timestamptz not null default now(),
    -- One spelling means one person within a scope. Overlaps across scopes are
    -- rejected in Go, where the other contact's name can be named in the error.
    unique (source, value_norm)
);

create index contact_aliases_contact_idx on contact_aliases (contact_id);
create index contact_aliases_norm_idx on contact_aliases (value_norm);

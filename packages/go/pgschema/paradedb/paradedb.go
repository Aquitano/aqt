// Package paradedb is the ParadeDB upgrade step every app runs before it
// migrates. It has no dependencies, so an app on another migration runner can
// share it without linking tern.
package paradedb

// UpdatePgSearch brings the pg_search catalog up to the installed extension. A
// new ParadeDB image only replaces the pg_search binary, and its SQL functions
// fail until the catalog is updated to match.
const UpdatePgSearch = `do $$ begin
  if exists (select from pg_extension e join pg_available_extensions a on a.name = e.extname
    where e.extname = 'pg_search' and e.extversion <> a.default_version) then
    alter extension pg_search update;
  end if;
end $$`

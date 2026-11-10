package store

import (
	"embed"
	"io/fs"
	"strconv"
	"strings"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// Migrations is the schema history Open applies, one numbered file per step.
var Migrations, _ = fs.Sub(migrationFiles, "migrations")

// Keep the legacy lock so an older command cannot migrate concurrently.
const migrationLock int64 = 0x61747469636d6967

// Schema holds every catalogue table, so the catalogue can share a database
// with bank's archive, whose tables are in public.
const Schema = "attic"

// standaloneTables are the tables migrations 0001 to 0015 created in public,
// while attic had a database to itself. Later migrations run in Schema, so
// this list never grows.
var standaloneTables = []string{
	"volumes", "scans", "contents", "entries", "entry_versions", "skips",
	"archives", "members", "archive_depth_failures", "texts", "metadata",
	"ai_results", "dedupe_moves",
}

// adoptStandaloneCatalogue moves such a catalogue into Schema, with its
// version table, in one transaction. It does nothing in bank's database,
// where public has no volumes or entries table.
var adoptStandaloneCatalogue = `do $$
declare
  t text;
begin
  perform pg_advisory_xact_lock(` + strconv.FormatInt(migrationLock, 10) + `);
  if to_regclass('attic.schema_version') is not null
     or to_regclass('public.volumes') is null or to_regclass('public.entries') is null then
    return;
  end if;
  if to_regclass('public.schema_version') is null then
    raise exception 'the catalogue in public predates schema_version; run attic migrate from the previous build first';
  end if;
  create schema if not exists attic;
  foreach t in array '{` + strings.Join(standaloneTables, ",") + `}'::text[] loop
    execute format('alter table if exists public.%I set schema attic', t);
  end loop;
  alter table public.schema_version set schema attic;
end $$`

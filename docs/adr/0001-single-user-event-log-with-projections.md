# ADR 0001: Single-user event log with projections

Date: 2026-06-10
Status: Accepted

## Context

aqt-health ingests health data from providers (Withings, Google Health, Health Connect)
into immutable ingestion batches/records, writes normalized per-metric sample tables, and
eagerly materializes derived projections (daily step summaries, sleep nights, canonical
per-day samples) after each ingestion. The architecture review (docs/backend-architecture-review.html)
observed that the system is, in substance, an event log with projections, but is not named
or operated as one: replay is not first-class, canonicalization is eager and drift-prone,
and several structurally identical scalar-sample tables exist side by side.

The system serves exactly one user. Data volumes are bounded by what one person's devices
produce (thousands of samples per day at worst).

## Decision

1. **Single-user is a deliberate constraint, not an accident.** There is no tenant column,
   no per-user auth model, and no plan to add them. Designs are evaluated at single-user
   data volumes; "what about 10k users" is out of scope.
2. **The architecture is an event log with projections.** Ingestion batches/records are the
   append-only source of truth. Everything else (metric sample tables, canonical tables,
   daily summaries) is a projection that must be rebuildable by replaying the log. New
   features should extend a projection or add a new one, never mutate the log.
3. **Projections are keyed by metric kind, not by field.** `MetricKind` / `DerivedKind`
   enums plus `Map<Kind, ...>` shapes and module registries (`DerivedRebuildModuleRegistry`,
   mirroring `HealthDayModuleRegistry` and `HealthProviderRegistry`) are the extension
   mechanism. Adding a metric family must not require touching per-field accumulators,
   result DTO fields, or executor branches.

## Planned follow-ups (v2 direction, not yet implemented)

- **Make replay first-class:** an admin endpoint that rebuilds any projection for a date
  range from ingestion records, used both for backfills and algorithm-version bumps.
- **Question eager canonicalization:** at single-user volumes a read-time
  `DISTINCT ON` + `date_bin` query can likely replace the canonical_* tables and their
  rebuild machinery, deleting the drift failure mode entirely. Spike before committing.
- **Fold the five structurally identical scalar-sample tables** (heart rate, respiratory
  rate, HRV, cardiovascular, extended body measurement) into one `scalar_samples` table
  keyed by metric kind.
- **Batch all wire-format breaks into one v2:** enum-typed record kinds, cursor pagination,
  and map-shaped count DTOs (replacing the twelve-field `MetricCreatedCountsResponse`)
  ship together in a single versioned API change, not piecemeal.

## Consequences

- Internal refactors (map-shaped counts/dates, module registries) can land without wire
  changes; the v1 response DTOs stay frozen until v2.
- Anything that cannot be rebuilt from the ingestion log is a bug in the design, not just
  in the code.
- Capacity/performance work targets algorithmic issues (e.g. quadratic bucket scans,
  re-parsing timestamps in comparators) rather than horizontal scaling.

# ADR 0001: Single-user event log with projections

Date: 2026-06-10
Status: Accepted

## Context

aqt-health ingests health data from providers (Withings, Google Health, Health Connect)
into immutable ingestion batches/records and derives everything else from them. The
system is, in substance, an event log with projections, and serves exactly one user;
data volumes are bounded by what one person's devices produce.

## Decision

1. **Single-user is a deliberate constraint, not an accident.** No tenant column, no
   per-user auth model, no plan to add them. Designs are evaluated at single-user data
   volumes; "what about 10k users" is out of scope.
2. **The architecture is an event log with projections.** Ingestion batches/records are
   the append-only source of truth. Everything else (metric sample tables, canonical
   views, daily summaries) is a projection that must be rebuildable by replaying the log.
   New features extend a projection or add a new one, never mutate the log.
3. **Projections are keyed by metric kind, not by field.** `MetricKind` / `DerivedKind`
   enums plus `Map<Kind, ...>` shapes and module registries are the extension mechanism.
   Adding a metric family must not require touching per-field accumulators, result DTO
   fields, or executor branches.

## Consequences

- Anything that cannot be rebuilt from the ingestion log is a bug in the design, not just
  in the code.
- Capacity/performance work targets algorithmic issues, not horizontal scaling.

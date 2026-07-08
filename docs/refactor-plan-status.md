# Refactor plan — status and remaining work

Status as of 2026-07-08. Tracks the five-phase drift/consolidation plan; one PR per branch.

## Merged to main

Batch merged 2026-07-08 (squash). The pairwise import conflicts the earlier merge-order note warned about never materialized as git conflicts, but two issues surfaced post-merge (each PR was only CI-green against its own older base) — both fixed forward in a hotfix PR:
- **Real semantic break:** `OpenApiParameters.kt` (from #60) imported `BatchStatus` from `api.dto`, but #56 moved it to `me.aquitano.health.domain`. Unresolved reference broke `compileKotlin`. Fixed by updating the import.
- **Local-only Konsist false positive:** `ArchitectureTest > api layer never references Exposed` (#64) failed locally because `Konsist.scopeFromProduction()` also scanned copies of the source under nested git worktrees (`.claude/worktrees`, `.t3/worktrees`) and stale `bin/` output carrying pre-refactor code. The real `src/main` tree is clean; CI on a fresh checkout was never affected. Fixed by slicing those paths out of the Konsist scope (rule itself unchanged).

Post-merge verification on `main` after the fixes: `./gradlew check` BUILD SUCCESSFUL (unit + Testcontainers integration + Konsist). Frontend contract-drift re-checked against a fresh `generateOpenApi` — the committed generated types **were stale** and drifted (reorder of path/schema emission + a few added endpoint descriptions; no renames or removals). Regenerated and kept; frontend `typecheck` clean, `vitest` 24/24 green against the new types.

| Item | PR | Merged |
|---|---|---|
| 1.1 Legacy scalar mappers delegate to registry | [#57](https://github.com/Aquitano/aqt-health/pull/57) | ✅ |
| 1.3 Query-parameter descriptors | [#60](https://github.com/Aquitano/aqt-health/pull/60) | ✅ |
| 1.4 Dead code deletion | [#55](https://github.com/Aquitano/aqt-health/pull/55) | ✅ |
| 1.5 Status-enum migration | [#56](https://github.com/Aquitano/aqt-health/pull/56) | ✅ |
| 2.1 Affected-dates mapping on DerivedRebuildModule | [#65](https://github.com/Aquitano/aqt-health/pull/65) | ✅ |
| 2.2 Idempotency keys for job-creating POSTs | [#66](https://github.com/Aquitano/aqt-health/pull/66) | ✅ |
| 3.1–3.4 Frontend hygiene | [#58](https://github.com/Aquitano/aqt-health/pull/58) | ✅ |
| 4.1 Generic DataTable | [#61](https://github.com/Aquitano/aqt-health/pull/61) | ✅ |
| 4.2 Chart shared helpers | [#63](https://github.com/Aquitano/aqt-health/pull/63) | ✅ |
| 4.6 Read-repository layering + Konsist rules | [#64](https://github.com/Aquitano/aqt-health/pull/64) | ✅ |

## Open — paused stack

| Item | PR | Branch | State |
|---|---|---|---|
| 1.2 Ingestion body schema inferred from DTO | [#59](https://github.com/Aquitano/aqt-health/pull/59) | `refactor/openapi-ingestion-batch-schema` | open, CI-green; base of #62 |
| 3.5 Generated types replace hand-written | [#62](https://github.com/Aquitano/aqt-health/pull/62) | `refactor/frontend-generated-types` (stacked on #59) | open, **Gradle tests failing** |

Deliberately left unmerged: #62's `Gradle tests` check is red on its base. Needs the failure diagnosed and fixed, then merge #59 first (#62 retargets to main automatically), regenerate frontend types, and merge #62.

## Plan corrections discovered during execution

- **5.1 and 5.2 are obsolete**: `V15__canonical_views_for_structural_metrics.sql` already replaced the three materialized canonical daily-summary tables with `DISTINCT ON` + `provider_ranks` views (the exact spike outcome). `DerivedKind` is already down to the two genuinely heavy materialized computations.
- `src/main/resources/openapi/aqt-health.yaml` (named in 1.4) never existed; nothing to delete.
- 1.1 caught real drift: Withings emitted `basal_metabolic_rate` in `kcal/day` vs the registry's `kcal` (fixed in #57).
- Verification note: `./gradlew test` runs only unit tests; the Testcontainers suites run under `./gradlew integrationTest`. CI's `./gradlew check` runs both.

## Batch merge — done

The Phase 1–4 batch (#56, #58, #60, #61, #63, #64, #65, #66) is merged to `main`; the post-merge semantic breaks were fixed forward in #67 (see above). `main` is green: `./gradlew check` passes, frontend types regenerated to match the merged contract.

## Remaining work — decisions and status

A pre-implementation assessment (2026-07-08) validated each remaining item against the merged `main` and corrected several stale premises. Decisions taken with the maintainer:

### 4.7 — API error vocabulary (in progress)
- Enumerate the reachable error `code` values (sourced from `ValidationIssueCodes`) as an OpenAPI enum on `ErrorResponse`; document per-endpoint codes.
- **Correction:** the three metric-type validators in `MetricQueryValidation.kt` have **zero callers** — they are being **deleted**, not consolidated into `validateMetricType(...)` (that would resurrect dead code). Add a shared `requiredPathParam()` only where hand-rolled null-checks actually remain.

### 5.4 — Ranged daily scalar-summary endpoint (in progress)
- **Made generic:** `GET /api/v2/metrics/{metricType}/daily?from=&to=` (not HR-specific — same effort, reusable) replaces the frontend's up-to-92-request per-day loop (`aqtHealthApi.ts:424-459`).
- New `ScalarSampleReadRepository` grouped query + `summaryDaily` in `ScalarMetricQueryService` + one route + `ScalarDailySummariesResponse` DTO reusing the `items`+`meta` envelope. Reuses the existing `scalarMetricQueryService` bean. Day-boundary bucketing must match the frontend's existing `dateOnlyToUtcInstant` convention (test-guarded).
- Suspense-split of the health-data page deferred (conflicts with other frontend work).

### 4.4 — Provider list envelope (queued, after 4.7/5.4)
- **Descoped:** `/metrics` already uses `items`. Only the 2 provider-list endpoints change: `providers` → `items` on `ProviderCatalogResponseDto` / `ProviderStatusCatalogResponseDto`. **No `meta` field** — provider lists are never paginated, so an always-null `nextCursor` would be cargo-cult. Update the frontend consumer (`aqtHealthApi.ts` ~256-278).

### 4.3 — DTO naming standardization (queued, after 4.4)
- **Descoped to response DTOs only:** rename `*Dto` → `*Response`/`*Request` for `Provider*`/`Read*`/`Trend*`/`Admin*` (component-name-only changes; JSON unaffected). Regenerate frontend types.
- **Ingestion renames deferred:** `StepIntervalDto` etc. are ingestion records whose component names come from decoupled string constants in `OpenApi.kt`; renaming collides head-on with the paused **#59** and would risk an ingestion wire-break the plan forbids. Do the ingestion portion only after #59 lands.

### 4.5 — DI cleanup (queued, last — rewrites route signatures)
- Regroup `AppModules.kt` by feature; `singleOf(::Type)`; delete the `ApplicationServices` bag + `buildApplicationServices()` for route-level `inject()`.
- Fold in the 1.5 follow-up: convert `ProviderSyncRunPort.finish(status: String)` to `SyncStatus`.
- **Corrections:** the `HealthDayQueryService` default-arg is already gone (no-op); registering `ProviderSyncPipeline` as a bean is optional polish (it's already a default constructor arg, so tests can inject fakes today).

### 5.3 — Generic daily-summary registry — DROPPED
Assessed as over-engineering. Scalars collapsed cleanly because they are homogeneous `(type, timestamp, value)`; daily summaries share only the `(id, date, source)` envelope, not the payload (activity has 13 fields, sleep is entirely different, steps is a count). A generic `kind`-keyed table would need ~25 sparse mostly-null columns or a JSON blob that discards the typed OpenAPI schema. The genuinely shared surface (`items`+`meta`, the `DISTINCT ON` V15 views) is already shared. Not worth the indirection.

### Small follow-ups
- `HealthDataVisualizations` `bodyMetricConfig` hardcoded hex hues: **not** a clean `var(--hue-*)` swap — only some metrics map to a semantically-matching token, others borrow a cross-named hue, so substitution can change meaning. Needs a deliberate token decision, not a blind replace.
- One-time per-page visual pass warranted for the chart-token change (#63) — stroke/hue regressions don't surface in unit tests.

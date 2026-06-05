# aqt-health

Personal, single-user health data hub built with Ktor, Kotlin, PostgreSQL, Exposed, and Flyway.

The service accepts normalized health batches from trusted scripts or provider adapters, stores the original source JSON for audit/reprocessing, writes structured metric tables, and exposes read endpoints for local tools.

## Stack

- Kotlin 2.3
- Ktor 3.4
- PostgreSQL via JDBC and HikariCP
- Exposed DAO for support entities only
- Exposed DSL for ingestion and metric reads/writes
- Flyway versioned migrations
- API-key authentication with `Authorization: Bearer <api-key>`

## Run Locally

Start PostgreSQL:

```bash
docker compose up -d postgres
```

The compose file uses `AQT_HEALTH_DB_USER`, `AQT_HEALTH_DB_PASSWORD`, `AQT_HEALTH_DB_PORT`, and `POSTGRES_DB` from the environment when set.

Bash:

```bash
export AQT_HEALTH_BOOTSTRAP_API_KEY="local-dev-key"
export AQT_HEALTH_JDBC_URL="jdbc:postgresql://localhost:5432/aqt_health"
export AQT_HEALTH_DB_USER="aqt_health"
export AQT_HEALTH_DB_PASSWORD="aqt_health"
./gradlew run
```

PowerShell:

```powershell
$env:AQT_HEALTH_BOOTSTRAP_API_KEY = "local-dev-key"
$env:AQT_HEALTH_JDBC_URL = "jdbc:postgresql://localhost:5432/aqt_health"
$env:AQT_HEALTH_DB_USER = "aqt_health"
$env:AQT_HEALTH_DB_PASSWORD = "aqt_health"
.\gradlew.bat run
```

The default database URL is `jdbc:postgresql://localhost:5432/aqt_health`. Flyway migrations run at startup.

Useful tasks:

```powershell
.\gradlew.bat test
.\gradlew.bat build
.\gradlew.bat run
```

## OpenAPI

The OpenAPI spec is generated from routing at runtime and served by Ktor.

After starting the app, open:

- `http://localhost:8080/openapi` (raw OpenAPI document)
- `http://localhost:8080/swagger` (Swagger UI)

## Configuration

Runtime config is read from `src/main/resources/application.yaml`.

Environment variables:

- `PORT`: HTTP port, default `8080`
- `AQT_HEALTH_JDBC_URL`: PostgreSQL JDBC URL, default `jdbc:postgresql://localhost:5432/aqt_health`
- `AQT_HEALTH_DB_USER`: PostgreSQL username, default `aqt_health`
- `AQT_HEALTH_DB_PASSWORD`: PostgreSQL password, default `aqt_health`
- `AQT_HEALTH_DB_MAX_POOL_SIZE`: maximum Hikari connection pool size, default `10`
- `AQT_HEALTH_BOOTSTRAP_CLIENT_NAME`: initial API client name, default `local-admin`
- `AQT_HEALTH_BOOTSTRAP_API_KEY`: optional plaintext bootstrap key
- `AQT_HEALTH_GOOGLE_CLIENT_ID`: Google OAuth web client ID for Google Health
- `AQT_HEALTH_GOOGLE_CLIENT_SECRET`: Google OAuth web client secret
- `AQT_HEALTH_GOOGLE_REDIRECT_URI`: OAuth callback URL, default `http://localhost:8080/api/v1/providers/google-health/oauth/callback`
- `AQT_HEALTH_GOOGLE_TOKEN_ENCRYPTION_KEY`: required before connecting Google Health; used to encrypt stored OAuth tokens
- `AQT_HEALTH_GOOGLE_API_BASE_URL`: Google Health API base URL, default `https://health.googleapis.com`
- `AQT_HEALTH_GOOGLE_OAUTH_TOKEN_URL`: Google OAuth token URL, default `https://oauth2.googleapis.com/token`
- `AQT_HEALTH_GOOGLE_OAUTH_AUTH_URL`: Google OAuth authorization URL, default `https://accounts.google.com/o/oauth2/v2/auth`
- `AQT_HEALTH_WITHINGS_CLIENT_ID`: Withings OAuth client ID
- `AQT_HEALTH_WITHINGS_CLIENT_SECRET`: Withings OAuth client secret
- `AQT_HEALTH_WITHINGS_REDIRECT_URI`: OAuth callback URL, default `http://localhost:8080/api/v1/providers/withings/oauth/callback`
- `AQT_HEALTH_WITHINGS_TOKEN_ENCRYPTION_KEY`: required before connecting Withings; used to encrypt stored OAuth tokens
- `AQT_HEALTH_WITHINGS_API_BASE_URL`: Withings API base URL, default `https://wbsapi.withings.net`
- `AQT_HEALTH_WITHINGS_OAUTH_TOKEN_URL`: Withings OAuth token URL, default `https://wbsapi.withings.net/v2/oauth2`
- `AQT_HEALTH_WITHINGS_OAUTH_AUTH_URL`: Withings OAuth authorization URL, default `https://account.withings.com/oauth2_user/authorize2`
- `AQT_HEALTH_LOG_FORMAT`: stdout log format, `text` by default or `json` for production JSON lines
- `AQT_HEALTH_LOG_FILE`: JSON lines log file for local inspection, default `build/logs/aqt-health.jsonl`
- `AQT_HEALTH_LOG_FILE_ROLLOVER`: rolling JSON log archive pattern, default `build/logs/aqt-health.%d{yyyy-MM-dd}.%i.jsonl.gz`
- `OPENOBSERVE_LOG_URL`: optional OpenObserve HTTP ingestion endpoint for direct app log delivery
- `OPENOBSERVE_AUTHORIZATION`: optional full OpenObserve authorization header value, for example `Basic ...`
- `AQT_HEALTH_ENV`: environment label added to forwarded logs, default `local`

If `AQT_HEALTH_BOOTSTRAP_API_KEY` is set, the app hashes it with SHA-256 and stores only `sha256:<hex>` in `api_clients`. If it is blank, startup still succeeds, but protected endpoints require a client row to exist in PostgreSQL.

PostgreSQL migrations require permission to run `CREATE EXTENSION IF NOT EXISTS btree_gist`. Managed deployments should enable `btree_gist` ahead of application startup if the application database user cannot create extensions.

For local secrets, copy `.env.example` to `.env` and put real values only in `.env`. The `.env` file is ignored by git.

PowerShell:

```powershell
Copy-Item .env.example .env
notepad .env

Get-Content .env | Where-Object { $_ -and $_ -notmatch '^\s*#' } | ForEach-Object {
  $name, $value = $_ -split '=', 2
  [Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim(), 'Process')
}

.\gradlew.bat run
```

Never commit `.env`, real API keys, database passwords, production URLs, or OpenObserve credentials. Commit only `.env.example` with placeholders.

## OpenObserve Logs

Application logs stay on the normal Logback stdout path. The app also writes JSON lines to `AQT_HEALTH_LOG_FILE` for local inspection and posts logs directly to OpenObserve when `OPENOBSERVE_LOG_URL` and `OPENOBSERVE_AUTHORIZATION` are set.

Local stdout logs default to readable text. Production can use JSON lines on stdout:

```powershell
$env:AQT_HEALTH_LOG_FORMAT = "json"
```

With the default local path, IntelliJ and Gradle runs write JSONL logs to:

```text
build/logs/aqt-health.jsonl
```

Set the OpenObserve environment variables before starting the app:

```powershell
$env:OPENOBSERVE_LOG_URL = "https://openobserve.example.com/api/<organization>/<stream>/_json"
$env:OPENOBSERVE_AUTHORIZATION = "Basic replace-with-rotated-openobserve-token"
$env:AQT_HEALTH_ENV = "local"
$env:AQT_HEALTH_LOG_FILE = "build/logs/aqt-health.jsonl"
```

Start the app from IntelliJ or Gradle:

```powershell
.\gradlew.bat run
```

The app sends each log event asynchronously as a one-record JSON batch to the OpenObserve `_json` endpoint. If either OpenObserve environment variable is blank, direct delivery is disabled and local stdout/file logging still works.

Do not hardcode the `Authorization` header in committed files; rotate any OpenObserve credential that has been pasted into chat, issue trackers, shell history, or logs.

For production, either keep direct OpenObserve delivery enabled with deployment secrets or route stdout/JSONL logs through a platform collector.

## Frontend Proxy Authentication

The Next.js frontend includes API routes under `frontend/app/api/**` that proxy privileged provider actions to the backend with `AQT_HEALTH_API_KEY`. Public deployments must protect those frontend routes before traffic reaches the backend key.

Set these variables in the frontend runtime:

- `AQT_HEALTH_API_BASE_URL`: backend API URL
- `AQT_HEALTH_API_KEY`: backend API key used only by the frontend server
- `AQT_HEALTH_FRONTEND_SESSION_SECRET`: random per-deployment session value required by privileged proxy routes
- `AQT_HEALTH_FRONTEND_SESSION_COOKIE`: optional cookie name, default `aqt_health_frontend_session`

Authenticated browser requests must include a cookie named by `AQT_HEALTH_FRONTEND_SESSION_COOKIE` whose value exactly matches `AQT_HEALTH_FRONTEND_SESSION_SECRET`. Put a real auth layer, private reverse proxy, or deployment access control in front of the app to issue that `HttpOnly`, `Secure`, `SameSite=Strict` cookie after user authentication. Mutation proxy routes also require same-origin requests and the `X-AQT-Health-CSRF: 1` header, which the frontend sends for its provider action buttons.

If `AQT_HEALTH_FRONTEND_SESSION_SECRET` is missing, privileged frontend proxy routes return `401` and do not use `AQT_HEALTH_API_KEY`.

## Health Check

Unauthenticated:

```bash
curl http://localhost:8080/api/v1/admin/health
```

## Ingest A Batch

```bash
curl -X POST http://localhost:8080/api/v1/ingestion/batches \
  -H "Authorization: Bearer local-dev-key" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "health_connect",
    "providerInstanceId": "pixel-8-health-connect",
    "batchExternalId": "demo-2026-04-19",
    "ingestedAt": "2026-04-19T10:00:00Z",
    "sourcePayload": {
      "exportId": "demo-2026-04-19"
    },
    "records": [
      {
        "type": "step_interval",
        "providerRecordId": "steps-1",
        "startAt": "2026-04-19T08:00:00Z",
        "endAt": "2026-04-19T09:00:00Z",
        "steps": 1200
      },
      {
        "type": "heart_rate",
        "providerRecordId": "hr-1",
        "measuredAt": "2026-04-19T08:30:00Z",
        "bpm": 62,
        "context": "resting"
      }
    ]
  }'
```

Supported record types:

- `step_interval`
- `sleep_session`
- `body_measurement`
- `heart_rate`

`batchExternalId` is idempotent per source instance. Provider record IDs are also used to skip duplicate metric rows where available.

## Raw vs Canonical Metrics

The database preserves raw provider rows for auditability. Cross-provider conflict resolution is applied at read time through `canonical=true|false`; no provider rows are deleted or rewritten.

Raw list endpoints default to `canonical=false`. Latest, summary, dashboard, and `/api/v1/health/day` reads default to `canonical=true`. Provider filters are applied before canonicalization, so `provider=withings&canonical=true` only reconciles matching Withings source instances.

Default source priorities are code-based in `CanonicalMetricsPolicy`:

- Steps and activity: Google Health or Health Connect first, then Withings.
- Body measurements: Withings first, then Google Health or Health Connect.
- Sleep sessions and sleep summaries: Withings first, then Google Health or Health Connect.
- Heart rate: same-timestamp conflicts prefer the denser source; ties prefer Withings for sleep context and Google Health or Health Connect for general/active context.
- Respiratory rate and HRV: Withings first, then Google Health or Health Connect.

Overlap handling:

- Steps: overlapping intervals from different sources keep the higher-priority interval; non-overlapping intervals are preserved.
- Sleep: overlapping sessions or summaries from different sources are grouped; richer staged sessions or more complete summaries win before provider priority.
- Heart rate, respiratory rate, and HRV: samples from different sources at the same or near-identical timestamp are de-duplicated within a 30-second tolerance.
- Body measurements: rows with the same metric type and timestamp from different sources resolve by provider priority.

Use `canonical=false` on read endpoints when inspecting all provider-specific rows, or `canonical=true` on list endpoints when a client wants the same conflict policy used by summaries and dashboards.

## Provider Discovery

All provider discovery endpoints require `Authorization: Bearer <api-key>`.

List registered providers and their sync capabilities:

```bash
curl "http://localhost:8080/api/v1/providers" \
  -H "Authorization: Bearer local-dev-key"
```

Get metadata for one provider:

```bash
curl "http://localhost:8080/api/v1/providers/google-health" \
  -H "Authorization: Bearer local-dev-key"
```

Discovery responses return canonical route provider codes. Google Health is returned as `google-health`; `google_health` is accepted as an alias for compatibility with internal source naming and older clients. Each provider descriptor includes OAuth requirements, supported and default `dataTypes`, max sync range, page-size support, and workflow endpoint paths for OAuth and sync.

## Provider Account Lifecycle

Provider OAuth accounts have first-class lifecycle state. Status responses expose account state, token status, last successful sync, last token refresh result, and the latest authentication error without returning encrypted or decrypted token values.

List provider readiness:

```bash
curl "http://localhost:8080/api/v1/providers/status" \
  -H "Authorization: Bearer local-dev-key"
```

List accounts for one provider:

```bash
curl "http://localhost:8080/api/v1/providers/google-health/accounts" \
  -H "Authorization: Bearer local-dev-key"
```

Connect starts the normal provider OAuth flow:

```bash
curl "http://localhost:8080/api/v1/providers/google-health/oauth/start" \
  -H "Authorization: Bearer local-dev-key"
```

Reconnect/re-consent validates an existing local account and starts the same OAuth flow again:

```bash
curl -X POST "http://localhost:8080/api/v1/providers/google-health/accounts/google-health-me/reconnect" \
  -H "Authorization: Bearer local-dev-key"
```

Disconnect is local-only. It clears locally stored OAuth token ciphertext, marks the account `disconnected`, preserves account metadata and sync history, and does not revoke tokens at Google or Withings:

```bash
curl -X POST "http://localhost:8080/api/v1/providers/google-health/accounts/google-health-me/disconnect" \
  -H "Authorization: Bearer local-dev-key"
```

If a refresh token is expired, invalid, or revoked, sync marks the account `needs_reauth`. Manual or future scheduled syncs skip accounts in `needs_reauth` or `disconnected` until reconnect completes.

## Google Health Provider

The Google Health provider is a server-owned OAuth integration. It reads Google Health data, normalizes it into the same ingestion batch contract shown above, stores the original Google response pages in `sourcePayload`, and writes the existing metric tables through the normal ingestion service.

Google's Google Health API docs currently recommend waiting until the end of May 2026 for an official launch and warn that breaking changes may occur before then. Sync uses Google's official generated Health client library for datapoint reads; the remaining Ktor Google client code is OAuth-only.

Google Cloud setup:

1. Create or choose a Google Cloud project.
2. Configure an OAuth consent screen.
3. Create an OAuth web client.
4. Add this authorized redirect URI: `http://localhost:8080/api/v1/providers/google-health/oauth/callback`
5. Put the client ID, client secret, redirect URI, and token encryption key in `.env`.

Required Google Health OAuth scopes:

- `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly`
- `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly`
- `https://www.googleapis.com/auth/googlehealth.sleep.readonly`

Start the OAuth flow:

```bash
curl "http://localhost:8080/api/v1/providers/google-health/oauth/start" \
  -H "Authorization: Bearer local-dev-key"
```

Open the returned `authorizationUrl` in a browser. Google redirects back to `/api/v1/providers/google-health/oauth/callback`, which stores encrypted tokens for future syncs.

Sync Google Health data:

```bash
curl -X POST http://localhost:8080/api/v1/providers/google-health/sync \
  -H "Authorization: Bearer local-dev-key" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "2026-04-01T00:00:00Z",
    "to": "2026-04-20T00:00:00Z",
    "dataTypes": ["steps", "sleep", "heart-rate", "weight", "body-fat"],
    "pageSize": 10000
  }'
```

If `dataTypes` is omitted, the sync reads `steps`, `sleep`, `heart-rate`, `weight`, and `body-fat`. If both `from` and `to` are omitted, the sync defaults to the last seven days. Explicit ranges must be no longer than 31 days. Completed windows are skipped on repeated syncs over the same range, and heart-rate syncs are fetched in one-day windows.

Google Health may return overlapping step intervals with different provider record IDs. To avoid inflated future totals, overlapping Google Health step intervals for the same account are skipped as duplicate metrics during ingestion. This guard is forward-looking only; it does not repair or remove historical rows that were ingested before the guard existed.

## Withings Provider

The Withings provider is a server-owned OAuth integration. It starts the Withings authorization flow, exchanges the callback authorization code immediately, stores encrypted access and refresh tokens in the shared provider OAuth table, reads Withings data, preserves the raw Withings response pages in ingestion `sourcePayload`, and writes supported normalized metrics through the normal ingestion service.

Withings developer setup:

1. Create or choose a Withings developer application.
2. Add this callback URL: `http://localhost:8080/api/v1/providers/withings/oauth/callback`
3. Put the client ID, client secret, redirect URI, and token encryption key in `.env`.

Required Withings OAuth scopes:

- `user.info`
- `user.metrics`
- `user.activity`

Start the OAuth flow:

```bash
curl "http://localhost:8080/api/v1/providers/withings/oauth/start" \
  -H "Authorization: Bearer local-dev-key"
```

Open the returned `authorizationUrl` in a browser. Withings redirects back to `/api/v1/providers/withings/oauth/callback`, which stores encrypted tokens for future syncs. Withings authorization codes are valid for only 30 seconds, so the callback must reach this backend immediately.

Sync Withings data:

```bash
curl -X POST http://localhost:8080/api/v1/providers/withings/sync \
  -H "Authorization: Bearer local-dev-key" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "2026-04-01T00:00:00Z",
    "to": "2026-04-20T00:00:00Z",
    "dataTypes": ["activity", "measures", "sleep-summary", "sleep"]
  }'
```

If `dataTypes` is omitted, the sync reads `activity`, `measures`, `sleep-summary`, and `sleep`. Withings fields from the listed Measure, Activity, Sleep, and Sleep Summary APIs are preserved in the ingestion source payload. The current normalized metric tables store steps, supported body measurements, heart-rate samples, and sleep sessions; unsupported Withings metrics such as blood pressure, SpO2, temperature, ECG intervals, BMR, metabolic age, bone mass, vascular age, segmental body composition, and conductance values remain available in source payloads until matching metric tables exist.

## Read Data

All read endpoints require `Authorization: Bearer <api-key>`.

Clients that need runtime discovery can call the compact metric catalog:

```bash
curl "http://localhost:8080/api/v1/metrics/catalog" \
  -H "Authorization: Bearer local-dev-key"
```

The catalog lists the supported metric families, read endpoint paths, common query parameters, aggregation modes, body measurement `metricType` values, response DTO names, and related provider data types. OpenAPI remains the formal schema contract for request and response shapes; the catalog is intentionally smaller and is meant for clients that need workflow decisions without hardcoding every metric surface.

```bash
curl "http://localhost:8080/api/v1/metrics/steps?from=2026-04-19T00:00:00Z&to=2026-04-20T00:00:00Z" \
  -H "Authorization: Bearer local-dev-key"

curl "http://localhost:8080/api/v1/metrics/steps?latest=true&includeSource=true" \
  -H "Authorization: Bearer local-dev-key"

curl "http://localhost:8080/api/v1/metrics/steps/daily?fromDate=2026-04-19&toDate=2026-04-19" \
  -H "Authorization: Bearer local-dev-key"

curl "http://localhost:8080/api/v1/sleep/sessions?includeSource=true" \
  -H "Authorization: Bearer local-dev-key"

curl "http://localhost:8080/api/v1/sleep/nights?date=2026-04-20&timezone=Europe/Berlin&includeSource=true" \
  -H "Authorization: Bearer local-dev-key"

curl "http://localhost:8080/api/v1/body/measurements?metricType=weight" \
  -H "Authorization: Bearer local-dev-key"

curl "http://localhost:8080/api/v1/body/measurements/latest?metricType=weight&includeSource=true" \
  -H "Authorization: Bearer local-dev-key"

curl "http://localhost:8080/api/v1/metrics/heart-rate" \
  -H "Authorization: Bearer local-dev-key"

curl "http://localhost:8080/api/v1/metrics/heart-rate?order=desc&limit=100" \
  -H "Authorization: Bearer local-dev-key"

curl "http://localhost:8080/api/v1/metrics/heart-rate/summary?from=2026-04-19T00:00:00Z&to=2026-04-20T00:00:00Z" \
  -H "Authorization: Bearer local-dev-key"
```

Admin ingestion views:

```bash
curl "http://localhost:8080/api/v1/admin/ingestion/batches" \
  -H "Authorization: Bearer local-dev-key"

curl "http://localhost:8080/api/v1/admin/ingestion/failures" \
  -H "Authorization: Bearer local-dev-key"
```

Common read filters:

- `from`: ISO-8601 instant, inclusive
- `to`: ISO-8601 instant, exclusive
- `provider`: source code, for example `health_connect`
- `providerInstanceId`: concrete provider/device/account instance
- `includeSource`: `true` or `false`
- `limit`: default `500`, max `5000`
- `sort`: endpoint-specific field; current metric list endpoints support `startAt`, `date`, or `measuredAt` as documented by OpenAPI and the metric catalog
- `order`: `asc` or `desc`, default `asc`

Metric list responses include an `items` array plus a `meta` object:

```json
{
  "items": [],
  "meta": {
    "count": 0,
    "limit": 500,
    "sort": "measuredAt",
    "order": "asc"
  }
}
```

Cursor pagination is intentionally not exposed yet. `nextCursor` is part of the response metadata contract but remains `null` and is omitted from JSON responses until real cursor pagination is added.

`latest=true` is supported on raw step samples, sleep sessions, body measurements, and heart-rate samples. It cannot be combined with `limit`, `sort`, or `order`; unsupported combinations return `400 validation_failed` with field-level details. Daily step summaries and sleep nights do not support `latest=true`; use `date` or descending `order` where appropriate.

Sleep reads have two modes:

- `/api/v1/sleep/sessions` is the raw instant-based read. Its `from` and `to` filters apply to session `startAt`, so it is useful for inspecting stored sessions by timestamp.
- `/api/v1/sleep/nights` is the calendar sleep-night read. It returns complete sessions, including all stages, and classifies each session by the localized date of `endAt`. `timezone` is an IANA timezone and defaults to `UTC`; pass it when clients need local calendar behavior. For example, `date=2026-04-20&timezone=Europe/Berlin` returns a session that starts at `2026-04-19T22:00:00Z` and ends at `2026-04-20T06:00:00Z` as the `2026-04-20` sleep night in `Europe/Berlin`. A session from the evening of April 20 to the morning of April 21 is returned for `date=2026-04-21`, not April 20, under those semantics.

## Storage Model

Ingestion tables:

- `ingestion_batches`
- `ingestion_records`

Metric tables:

- `step_samples`
- `step_daily_summaries`
- `sleep_sessions`
- `sleep_stages`
- `body_measurements`
- `heart_rate_samples`

Support tables:

- `sources`
- `source_instances`
- `api_clients`
- `provider_oauth_accounts`
- `provider_oauth_states`
- `provider_sync_runs`

Timestamps are stored as PostgreSQL `timestamptz` values and returned as UTC ISO-8601 strings. Daily step summaries use UTC dates and assign each interval to the date of `startAt`.

## Tests

```powershell
.\gradlew.bat test
```

Tests run against temporary PostgreSQL databases via Testcontainers and apply the same Flyway migrations as the application.
If Docker is unavailable, point tests at an existing PostgreSQL database; each test gets an isolated schema:

```bash
export AQT_HEALTH_TEST_JDBC_URL="jdbc:postgresql://localhost:5432/aqt_health_test"
export AQT_HEALTH_TEST_DB_USER="aqt_health"
export AQT_HEALTH_TEST_DB_PASSWORD="aqt_health"
./gradlew test
```

## Contributing

For coding standards, development workflows, and conventional commit guidelines used in this project, please see the [CONTRIBUTING.md](CONTRIBUTING.md) guide.


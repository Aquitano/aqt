# aqt-health

Personal, single-user health data hub built with Ktor, Kotlin, SQLite, Exposed, and Flyway.

The service accepts normalized health batches from trusted scripts or provider adapters, stores the original source JSON for audit/reprocessing, writes structured metric tables, and exposes read endpoints for local tools.

## Stack

- Kotlin 2.3
- Ktor 3.4
- SQLite via `org.xerial:sqlite-jdbc`
- Exposed DAO for support entities only
- Exposed DSL for ingestion and metric reads/writes
- Flyway versioned migrations
- API-key authentication with `Authorization: Bearer <api-key>`

## Run Locally

PowerShell:

```powershell
$env:AQT_HEALTH_BOOTSTRAP_API_KEY = "local-dev-key"
.\gradlew.bat run
```

The default database is `./data/aqt-health.db`. Flyway migrations run at startup.

Useful tasks:

```powershell
.\gradlew.bat test
.\gradlew.bat build
.\gradlew.bat run
```

## OpenAPI

The OpenAPI spec is stored at `src/main/resources/openapi/aqt-health.yaml` and is served by Ktor.

After starting the app, open:

- `http://localhost:8080/openapi`
- `http://localhost:8080/swagger`

## Configuration

Runtime config is read from `src/main/resources/application.yaml`.

Environment variables:

- `PORT`: HTTP port, default `8080`
- `AQT_HEALTH_JDBC_URL`: SQLite JDBC URL, default `jdbc:sqlite:./data/aqt-health.db`
- `AQT_HEALTH_BOOTSTRAP_CLIENT_NAME`: initial API client name, default `local-admin`
- `AQT_HEALTH_BOOTSTRAP_API_KEY`: optional plaintext bootstrap key
- `AQT_HEALTH_GOOGLE_CLIENT_ID`: Google OAuth web client ID for Google Health
- `AQT_HEALTH_GOOGLE_CLIENT_SECRET`: Google OAuth web client secret
- `AQT_HEALTH_GOOGLE_REDIRECT_URI`: OAuth callback URL, default `http://localhost:8080/api/v1/providers/google-health/oauth/callback`
- `AQT_HEALTH_GOOGLE_TOKEN_ENCRYPTION_KEY`: required before connecting Google Health; used to encrypt stored OAuth tokens
- `AQT_HEALTH_GOOGLE_API_BASE_URL`: Google Health API base URL, default `https://health.googleapis.com`
- `AQT_HEALTH_GOOGLE_OAUTH_TOKEN_URL`: Google OAuth token URL, default `https://oauth2.googleapis.com/token`
- `AQT_HEALTH_GOOGLE_OAUTH_AUTH_URL`: Google OAuth authorization URL, default `https://accounts.google.com/o/oauth2/v2/auth`
- `AQT_HEALTH_LOG_FORMAT`: stdout log format, `text` by default or `json` for production JSON lines
- `AQT_HEALTH_LOG_FILE`: JSON lines log file for local inspection, default `build/logs/aqt-health.jsonl`
- `AQT_HEALTH_LOG_FILE_ROLLOVER`: rolling JSON log archive pattern, default `build/logs/aqt-health.%d{yyyy-MM-dd}.%i.jsonl.gz`
- `OPENOBSERVE_LOG_URL`: optional OpenObserve HTTP ingestion endpoint for direct app log delivery
- `OPENOBSERVE_AUTHORIZATION`: optional full OpenObserve authorization header value, for example `Basic ...`
- `AQT_HEALTH_ENV`: environment label added to forwarded logs, default `local`

If `AQT_HEALTH_BOOTSTRAP_API_KEY` is set, the app hashes it with SHA-256 and stores only `sha256:<hex>` in `api_clients`. If it is blank, startup still succeeds, but protected endpoints require a client row to exist in SQLite.

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
$env:OPENOBSERVE_LOG_URL = "https://logs.aquitano.me/api/3CdQ3ffpBGmNl0nnh49QbvpHyj2/default/_json"
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

## Google Health Provider

The Google Health provider is a server-owned OAuth integration. It reads Google Health data, normalizes it into the same ingestion batch contract shown above, stores the original Google response pages in `sourcePayload`, and writes the existing metric tables through the normal ingestion service.

Google's Google Health API docs currently recommend waiting until the end of May 2026 for an official launch and warn that breaking changes may occur before then. This integration uses a small REST client rather than a generated client so the request/response handling stays easy to adjust.

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
    "pageSize": 1000
  }'
```

If `dataTypes` is omitted, the sync reads `steps`, `sleep`, `heart-rate`, `weight`, and `body-fat`. If both `from` and `to` are omitted, the sync defaults to the last seven days. Explicit ranges must be no longer than 31 days.

## Read Data

All read endpoints require `Authorization: Bearer <api-key>`.

```bash
curl "http://localhost:8080/api/v1/metrics/steps?from=2026-04-19T00:00:00Z&to=2026-04-20T00:00:00Z" \
  -H "Authorization: Bearer local-dev-key"

curl "http://localhost:8080/api/v1/metrics/steps/daily?fromDate=2026-04-19&toDate=2026-04-19" \
  -H "Authorization: Bearer local-dev-key"

curl "http://localhost:8080/api/v1/sleep/sessions?includeSource=true" \
  -H "Authorization: Bearer local-dev-key"

curl "http://localhost:8080/api/v1/body/measurements?metricType=weight" \
  -H "Authorization: Bearer local-dev-key"

curl "http://localhost:8080/api/v1/metrics/heart-rate" \
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

Timestamps are stored as UTC ISO-8601 text. Daily step summaries use UTC dates and assign each interval to the date of `startAt`.

## Tests

```powershell
.\gradlew.bat test
```

Tests run against temporary SQLite files and apply the same Flyway migrations as the application.

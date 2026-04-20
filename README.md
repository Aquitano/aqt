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

Never commit `.env`, real API keys, database passwords, or production URLs. Commit only `.env.example` with placeholders.

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

Timestamps are stored as UTC ISO-8601 text. Daily step summaries use UTC dates and assign each interval to the date of `startAt`.

## Tests

```powershell
.\gradlew.bat test
```

Tests run against temporary SQLite files and apply the same Flyway migrations as the application.

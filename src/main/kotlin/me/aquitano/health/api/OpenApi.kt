@file:OptIn(io.ktor.utils.io.ExperimentalKtorApi::class)

package me.aquitano.health.api

import io.ktor.http.HttpStatusCode
import io.ktor.openapi.Components
import io.ktor.openapi.ExampleObject
import io.ktor.openapi.GenericElement
import io.ktor.openapi.GenericElementString
import io.ktor.openapi.HttpSecurityScheme
import io.ktor.openapi.JsonSchema
import io.ktor.openapi.JsonSchemaDiscriminator
import io.ktor.openapi.JsonType
import io.ktor.openapi.OpenApiDoc
import io.ktor.openapi.OpenApiInfo
import io.ktor.openapi.Operation
import io.ktor.openapi.ReferenceOr
import io.ktor.openapi.SecurityScheme
import io.ktor.openapi.Server
import io.ktor.openapi.Tag
import io.ktor.server.routing.Route
import io.ktor.server.routing.openapi.describe
import kotlinx.serialization.builtins.serializer
import me.aquitano.health.api.dto.BodyMeasurementsResponse
import me.aquitano.health.api.dto.DashboardSummaryResponse
import me.aquitano.health.api.dto.HeartRateSamplesResponse
import me.aquitano.health.api.dto.IngestionBatchRequest
import me.aquitano.health.api.dto.IngestionSummaryResponse
import me.aquitano.health.api.dto.MetricCatalogResponseDto
import me.aquitano.health.api.dto.ProviderCatalogResponseDto
import me.aquitano.health.api.dto.ProviderDescriptorResponseDto
import me.aquitano.health.api.dto.ProviderOAuthCallbackResponse
import me.aquitano.health.api.dto.ProviderOAuthStartResponse
import me.aquitano.health.api.dto.ProviderStatusCatalogResponseDto
import me.aquitano.health.api.dto.ProviderStatusResponseDto
import me.aquitano.health.api.dto.ProviderSyncRequestDto
import me.aquitano.health.api.dto.ProviderSyncResponseDto
import me.aquitano.health.api.dto.SleepNightsResponse
import me.aquitano.health.api.dto.SleepSessionsResponse
import me.aquitano.health.api.dto.StepDailySummariesResponse
import me.aquitano.health.api.dto.StepSamplesResponse
import me.aquitano.health.domain.BodyMetricTypes
import kotlin.reflect.typeOf

internal const val BearerApiKeySecurityScheme = "bearerApiKey"

internal fun openApiInfo(): OpenApiInfo =
    OpenApiInfo(
        title = "aqt-health",
        version = "0.0.1",
        description = "Personal health data hub API for normalized ingestion, provider OAuth and sync workflows, metric reads, and local administration.",
        contact = null,
    )

internal fun openApiBaseDoc(): OpenApiDoc =
    OpenApiDoc(
        openapi = OpenApiDoc.OPENAPI_VERSION,
        info = openApiInfo(),
        servers = listOf(
            Server(url = "/", description = "Same-origin deployment"),
            Server(url = "http://localhost:8080", description = "Local development"),
        ),
        paths = emptyMap(),
        webhooks = emptyMap(),
        components = openApiComponents(),
        security = listOf(mapOf(BearerApiKeySecurityScheme to emptyList())),
        tags = listOf(
            Tag("Admin", "Health checks and ingestion administration."),
            Tag("Ingestion", "Normalized health batch ingestion for trusted clients and provider adapters."),
            Tag("Providers", "Provider discovery, OAuth connection, status, and synchronization workflows."),
            Tag("Read", "Metric catalog and read endpoints for health data queries."),
        ),
        externalDocs = null,
        extensions = emptyMap(),
    )

private fun openApiComponents(): Components =
    Components(
        securitySchemes = mapOf(
            BearerApiKeySecurityScheme to ReferenceOr.Value<SecurityScheme>(
                HttpSecurityScheme(
                    scheme = "bearer",
                    bearerFormat = "API key",
                    description = "Use `Authorization: Bearer <api-key>` with an API key registered in aqt-health.",
                )
            )
        ),
        examples = mapOf(
            "ErrorResponse" to ReferenceOr.Value(
                jsonExample(
                    summary = "Validation error",
                    json = """
                        {
                          "error": {
                            "code": "validation_failed",
                            "message": "Request validation failed",
                            "requestId": "test-request-123",
                            "details": [
                              {
                                "field": "fromDate",
                                "code": "invalid_format",
                                "message": "must be an ISO-8601 date"
                              }
                            ]
                          }
                        }
                    """.trimIndent(),
                )
            ),
        ),
    )

internal fun Operation.Builder.publicEndpoint() {
    security {
        optional()
    }
}

internal fun Operation.Builder.requiresBearerAuth() {
    security {
        requirement(BearerApiKeySecurityScheme)
    }
}

internal inline fun <reified T : Any> Operation.Builder.jsonRequest(
    descriptionText: String,
    exampleName: String? = null,
    example: ExampleObject? = null,
) {
    requestBody {
        description = descriptionText
        required = true
        if (exampleName != null && example != null) {
            content {
                schema = buildSchema(typeOf<T>())
                example(exampleName, example)
            }
        } else {
            schema = buildSchema(typeOf<T>())
        }
    }
}

internal fun Operation.Builder.ingestionBatchJsonRequest() {
    requestBody {
        description = "Normalized ingestion batch. Fields are nullable at the transport layer where provider adapters may omit them, but validation enforces provider, providerInstanceId, batch identity, and record-specific required fields."
        required = true
        content {
            schema = JsonSchema(
                type = JsonType.OBJECT,
                properties = mapOf(
                    "provider" to ReferenceOr.Value(stringSchema(example = "withings")),
                    "providerInstanceId" to ReferenceOr.Value(stringSchema(example = "withings:123456")),
                    "batchExternalId" to ReferenceOr.Value(stringSchema(example = "withings-2026-04-02T00:00:00Z")),
                    "ingestedAt" to ReferenceOr.Value(stringSchema(format = "date-time", example = "2026-04-02T08:15:30Z")),
                    "sourcePayload" to ReferenceOr.Value(JsonSchema(type = JsonType.OBJECT)),
                    "records" to ReferenceOr.Value(
                        JsonSchema(
                            type = JsonType.ARRAY,
                            items = ReferenceOr.Value(ingestionRecordSchema()),
                        )
                    ),
                ),
            )
            example("batch", ingestionBatchExample())
        }
    }
}

internal inline fun <reified T : Any> Operation.Builder.jsonResponse(
    status: HttpStatusCode,
    descriptionText: String,
    exampleName: String? = null,
    example: ExampleObject? = null,
) {
    responses {
        status {
            description = descriptionText
            if (exampleName != null && example != null) {
                content {
                    schema = buildSchema(typeOf<T>())
                    example(exampleName, example)
                }
            } else {
                schema = buildSchema(typeOf<T>())
            }
        }
    }
}

internal fun Operation.Builder.errorResponses(
    unauthorized: Boolean = true,
    validation: Boolean = true,
    notFound: Boolean = false,
    conflict: Boolean = false,
    upstream: Boolean = false,
    internal: Boolean = true,
) {
    responses {
        commonErrors(
            unauthorized = unauthorized,
            validation = validation,
            notFound = notFound,
            conflict = conflict,
            upstream = upstream,
            internal = internal,
        )
        defaultError()
    }
}

internal fun io.ktor.openapi.Responses.Builder.defaultError() {
    default {
        description = "Error response"
        content {
            schema = buildSchema(typeOf<ErrorResponse>())
            example(
                "error",
                jsonExample(
                    summary = "Standard error envelope",
                    json = """
                        {
                          "error": {
                            "code": "validation_failed",
                            "message": "Request validation failed",
                            "requestId": "test-request-123"
                          }
                        }
                    """.trimIndent(),
                )
            )
        }
    }
}

internal fun io.ktor.openapi.Responses.Builder.commonErrors(
    unauthorized: Boolean = true,
    validation: Boolean = true,
    notFound: Boolean = false,
    conflict: Boolean = false,
    upstream: Boolean = false,
    internal: Boolean = true,
) {
    if (validation) {
        HttpStatusCode.BadRequest {
            description = "Request validation failed"
            schema = buildSchema(typeOf<ErrorResponse>())
        }
    }
    if (unauthorized) {
        HttpStatusCode.Unauthorized {
            description = "Missing or invalid API key"
            schema = buildSchema(typeOf<ErrorResponse>())
        }
    }
    if (notFound) {
        HttpStatusCode.NotFound {
            description = "Resource not found"
            schema = buildSchema(typeOf<ErrorResponse>())
        }
    }
    if (conflict) {
        HttpStatusCode.Conflict {
            description = "Request conflicts with current state"
            schema = buildSchema(typeOf<ErrorResponse>())
        }
    }
    if (upstream) {
        HttpStatusCode.BadGateway {
            description = "Upstream provider request failed"
            schema = buildSchema(typeOf<ErrorResponse>())
        }
    }
    if (internal) {
        HttpStatusCode.InternalServerError {
            description = "Unexpected server error"
            schema = buildSchema(typeOf<ErrorResponse>())
        }
    }
}

internal fun Operation.Builder.providerCodePath() {
    parameters {
        path("providerCode") {
            description = "Provider code. Current examples are `google-health` and `withings`."
            schema = stringSchema(enumValues = listOf("google-health", "withings"), example = "withings")
        }
    }
}

internal fun Operation.Builder.readQueryParameters(includeLatest: Boolean = false) {
    parameters {
        query("from") {
            description = "Inclusive start timestamp or date. Date-only values are interpreted by the endpoint's query service."
            schema = stringSchema(format = "date-time", example = "2026-04-01T00:00:00Z")
        }
        query("to") {
            description = "Exclusive end timestamp or date. Date-only values are interpreted by the endpoint's query service."
            schema = stringSchema(format = "date-time", example = "2026-04-02T00:00:00Z")
        }
        query("provider") {
            description = "Source provider filter."
            schema = stringSchema(example = "withings")
        }
        query("providerInstanceId") {
            description = "Source provider account or instance filter."
            schema = stringSchema(example = "withings:123456")
        }
        query("includeSource") {
            description = "Include source provider metadata in each item. Defaults to false."
            schema = booleanSchema(default = false, example = false)
        }
        if (includeLatest) {
            query("latest") {
                description = "Return the latest matching item when true. Defaults to false."
                schema = booleanSchema(default = false, example = true)
            }
        }
        query("limit") {
            description = "Maximum number of items. Defaults to 500 and cannot exceed 5000."
            schema = integerSchema(default = 500, minimum = 1.0, maximum = 5000.0, example = 100)
        }
    }
}

internal fun Operation.Builder.dailyStepQueryParameters() {
    readQueryParameters()
    dateRangeQueryParameters("UTC date")
}

internal fun Operation.Builder.sleepNightQueryParameters() {
    parameters {
        query("date") {
            description = "Exact sleep night date or `today`. Matches the localized date of session endAt and cannot be combined with fromDate or toDate."
            schema = stringSchema(format = "date", example = "2026-04-02")
        }
        query("fromDate") {
            description = "Inclusive local sleep-night start date based on session endAt."
            schema = stringSchema(format = "date", example = "2026-04-01")
        }
        query("toDate") {
            description = "Inclusive local sleep-night end date based on session endAt."
            schema = stringSchema(format = "date", example = "2026-04-07")
        }
        query("timezone") {
            description = "IANA timezone used to classify endAt dates. Defaults to UTC."
            schema = stringSchema(example = "Europe/Berlin")
        }
        query("provider") {
            description = "Source provider filter."
            schema = stringSchema(example = "withings")
        }
        query("providerInstanceId") {
            description = "Source provider account or instance filter."
            schema = stringSchema(example = "withings:123456")
        }
        query("includeSource") {
            description = "Include source provider metadata in each item. Defaults to false."
            schema = booleanSchema(default = false, example = false)
        }
        query("limit") {
            description = "Maximum number of items. Defaults to 500, cannot exceed 5000, and is ignored as 1 when date is provided."
            schema = integerSchema(default = 500, minimum = 1.0, maximum = 5000.0, example = 7)
        }
    }
}

internal fun Operation.Builder.bodyMeasurementQueryParameters() {
    readQueryParameters(includeLatest = true)
    parameters {
        query("metricType") {
            description = "Body measurement type filter."
            schema = stringSchema(
                enumValues = BodyMetricTypes.supported.sorted(),
                example = BodyMetricTypes.WEIGHT,
            )
        }
    }
}

internal fun Operation.Builder.dashboardQueryParameters() {
    parameters {
        query("fromDate") {
            description = "Inclusive UTC start date for dashboard summaries."
            required = true
            schema = stringSchema(format = "date", example = "2026-04-01")
        }
        query("toDate") {
            description = "Inclusive UTC end date for dashboard summaries."
            required = true
            schema = stringSchema(format = "date", example = "2026-04-07")
        }
        query("provider") {
            description = "Source provider filter applied to summary metric lookups."
            schema = stringSchema(example = "withings")
        }
        query("providerInstanceId") {
            description = "Source provider account or instance filter applied to summary metric lookups."
            schema = stringSchema(example = "withings:123456")
        }
        query("includeSource") {
            description = "Include source provider metadata for nested latest items. Defaults to false."
            schema = booleanSchema(default = false, example = false)
        }
    }
}

internal fun Operation.Builder.adminQueryParameters() {
    parameters {
        query("status") {
            description = "Batch status filter."
            schema = stringSchema(enumValues = listOf("accepted", "failed", "duplicate"), example = "failed")
        }
        query("from") {
            description = "Inclusive received-at start timestamp."
            schema = stringSchema(format = "date-time", example = "2026-04-01T00:00:00Z")
        }
        query("to") {
            description = "Exclusive received-at end timestamp."
            schema = stringSchema(format = "date-time", example = "2026-04-02T00:00:00Z")
        }
        query("limit") {
            description = "Maximum number of items. Defaults to 100 and cannot exceed 1000 for admin list endpoints."
            schema = integerSchema(default = 100, minimum = 1.0, maximum = 1000.0, example = 50)
        }
    }
}

private fun Operation.Builder.dateRangeQueryParameters(label: String) {
    parameters {
        query("date") {
            description = "Exact $label or `today`. Cannot be combined with fromDate or toDate."
            schema = stringSchema(format = "date", example = "2026-04-02")
        }
        query("fromDate") {
            description = "Inclusive $label start date."
            schema = stringSchema(format = "date", example = "2026-04-01")
        }
        query("toDate") {
            description = "Inclusive $label end date."
            schema = stringSchema(format = "date", example = "2026-04-07")
        }
    }
}

internal inline fun <reified T : Any> Route.describeReadOperation(
    operationId: String,
    summary: String,
    descriptionText: String,
    includeLatest: Boolean = false,
): Route = describe {
    this.operationId = operationId
    tag("Read")
    this.summary = summary
    description = descriptionText
    requiresBearerAuth()
    readQueryParameters(includeLatest = includeLatest)
    jsonResponse<T>(HttpStatusCode.OK, summary, "example", metricListExample<T>())
    errorResponses()
}

internal fun Route.describeDailyStepReadOperation(): Route = describe {
    operationId = "listDailyStepSummaries"
    tag("Read")
    summary = "List daily step summaries"
    description = "Returns daily UTC step totals. Use `date` for one day, or `fromDate` and `toDate` for an inclusive date range. `from` and `to` are also accepted by the shared query parser for timestamp-style filters."
    requiresBearerAuth()
    dailyStepQueryParameters()
    jsonResponse<StepDailySummariesResponse>(HttpStatusCode.OK, "Daily step summaries", "dailySteps", stepDailySummariesExample())
    errorResponses()
}

internal fun Route.describeSleepNightReadOperation(): Route = describe {
    operationId = "listSleepNights"
    tag("Read")
    summary = "List sleep nights"
    description = "Returns sleep sessions classified by the localized date of `endAt`. Use `timezone` to control night boundaries."
    requiresBearerAuth()
    sleepNightQueryParameters()
    jsonResponse<SleepNightsResponse>(HttpStatusCode.OK, "Sleep nights", "sleepNights", sleepNightsExample())
    errorResponses()
}

internal fun stringSchema(
    format: String? = null,
    enumValues: List<String> = emptyList(),
    example: String? = null,
    default: String? = null,
): JsonSchema =
    JsonSchema(
        type = JsonType.STRING,
        format = format,
        enum = enumValues.map { stringElement(it) }.ifEmpty { null },
        example = example?.let(::stringElement),
        default = default?.let(::stringElement),
    )

internal fun integerSchema(
    default: Int? = null,
    minimum: Double? = null,
    maximum: Double? = null,
    example: Int? = null,
): JsonSchema =
    JsonSchema(
        type = JsonType.INTEGER,
        default = default?.let { GenericElement.encodeToElement(Int.serializer(), it) },
        minimum = minimum,
        maximum = maximum,
        example = example?.let { GenericElement.encodeToElement(Int.serializer(), it) },
    )

internal fun booleanSchema(default: Boolean? = null, example: Boolean? = null): JsonSchema =
    JsonSchema(
        type = JsonType.BOOLEAN,
        default = default?.let { GenericElement.encodeToElement(Boolean.serializer(), it) },
        example = example?.let { GenericElement.encodeToElement(Boolean.serializer(), it) },
    )

internal fun ingestionBatchExample(): ExampleObject =
    jsonExample(
        summary = "Batch with normalized records",
        json = """
            {
              "provider": "withings",
              "providerInstanceId": "withings:123456",
              "batchExternalId": "withings-2026-04-02T00:00:00Z",
              "ingestedAt": "2026-04-02T08:15:30Z",
              "sourcePayload": {
                "job": "daily-sync"
              },
              "records": [
                {
                  "type": "step_interval",
                  "providerRecordId": "steps-1",
                  "startAt": "2026-04-02T07:00:00Z",
                  "endAt": "2026-04-02T08:00:00Z",
                  "steps": 1200
                },
                {
                  "type": "sleep_session",
                  "providerRecordId": "sleep-1",
                  "startAt": "2026-04-01T22:30:00Z",
                  "endAt": "2026-04-02T06:45:00Z",
                  "stages": [
                    {
                      "stage": "deep",
                      "startAt": "2026-04-01T23:00:00Z",
                      "endAt": "2026-04-01T23:45:00Z"
                    }
                  ]
                },
                {
                  "type": "body_measurement",
                  "providerRecordId": "weight-1",
                  "measuredAt": "2026-04-02T06:50:00Z",
                  "weightKg": 78.4
                },
                {
                  "type": "heart_rate",
                  "providerRecordId": "hr-1",
                  "measuredAt": "2026-04-02T08:05:00Z",
                  "bpm": 62,
                  "context": "resting"
                }
              ]
            }
        """.trimIndent(),
    )

internal fun ingestionSummaryExample(duplicate: Boolean = false): ExampleObject =
    jsonExample(
        summary = if (duplicate) "Duplicate batch" else "Created batch",
        json = """
            {
              "batchId": 42,
              "status": "accepted",
              "duplicateBatch": $duplicate,
              "recordsReceived": 4,
              "ingestionRecordsStored": ${if (duplicate) 0 else 4},
              "metricsCreated": {
                "stepSamples": ${if (duplicate) 0 else 1},
                "sleepSessions": ${if (duplicate) 0 else 1},
                "sleepStages": ${if (duplicate) 0 else 1},
                "bodyMeasurements": ${if (duplicate) 0 else 1},
                "heartRateSamples": ${if (duplicate) 0 else 1}
              },
              "metricsSkipped": {
                "duplicates": ${if (duplicate) 4 else 0}
              },
              "affectedStepSummaryDates": [
                "2026-04-02"
              ]
            }
        """.trimIndent(),
    )

internal fun providerCatalogExample(): ExampleObject =
    jsonExample(
        summary = "Provider catalog",
        json = """
            {
              "providers": [
                {
                  "providerCode": "withings",
                  "displayName": "Withings",
                  "authType": "oauth2",
                  "requiresAuthentication": true,
                  "supportedDataTypes": ["activity", "measures", "sleep", "sleep-summary"],
                  "defaultDataTypes": ["activity", "measures", "sleep"],
                  "maxSyncRangeDays": 30,
                  "supportsPageSize": true,
                  "workflowEndpoints": {
                    "oauthStart": "/api/v1/providers/withings/oauth/start",
                    "oauthCallback": "/api/v1/providers/withings/oauth/callback",
                    "sync": "/api/v1/providers/withings/sync"
                  },
                  "aliases": []
                }
              ]
            }
        """.trimIndent(),
    )

internal fun providerStatusExample(): ExampleObject =
    jsonExample(
        summary = "Provider statuses",
        json = """
            {
              "providers": [
                {
                  "providerCode": "withings",
                  "displayName": "Withings",
                  "configured": true,
                  "connected": true,
                  "needsAuthentication": false,
                  "canSync": true,
                  "nextAction": "sync",
                  "accounts": [
                    {
                      "providerInstanceId": "withings:123456",
                      "connectedAt": "2026-04-01T10:00:00Z",
                      "lastSyncAt": "2026-04-02T08:00:00Z",
                      "tokenStatus": "valid",
                      "expiresAt": "2026-05-01T10:00:00Z"
                    }
                  ]
                }
              ]
            }
        """.trimIndent(),
    )

internal fun oauthStartExample(): ExampleObject =
    jsonExample(
        summary = "OAuth authorization URL",
        json = """
            {
              "provider": "withings",
              "authorizationUrl": "https://account.withings.com/oauth2_user/authorize2?...",
              "expiresAt": "2026-04-02T08:20:30Z"
            }
        """.trimIndent(),
    )

internal fun oauthCallbackExample(): ExampleObject =
    jsonExample(
        summary = "OAuth callback success",
        json = """
            {
              "provider": "withings",
              "providerInstanceId": "withings:123456",
              "connected": true
            }
        """.trimIndent(),
    )

internal fun providerSyncRequestExample(): ExampleObject =
    jsonExample(
        summary = "Provider sync request",
        json = """
            {
              "providerInstanceId": "withings:123456",
              "from": "2026-04-01T00:00:00Z",
              "to": "2026-04-02T00:00:00Z",
              "dataTypes": ["activity", "measures"],
              "pageSize": 100
            }
        """.trimIndent(),
    )

internal fun providerSyncResponseExample(): ExampleObject =
    jsonExample(
        summary = "Provider sync result with partial errors",
        json = """
            {
              "providerCode": "withings",
              "providerInstanceId": "withings:123456",
              "requestedFrom": "2026-04-01T00:00:00Z",
              "requestedTo": "2026-04-02T00:00:00Z",
              "status": "partial_success",
              "batches": [
                {
                  "dataType": "activity",
                  "batchId": 42,
                  "duplicateBatch": false,
                  "recordsReceived": 12,
                  "ingestionRecordsStored": 12,
                  "metricsCreated": {
                    "stepSamples": 12,
                    "sleepSessions": 0,
                    "sleepStages": 0,
                    "bodyMeasurements": 0,
                    "heartRateSamples": 0
                  },
                  "duplicateMetricsSkipped": 0,
                  "affectedStepSummaryDates": ["2026-04-01", "2026-04-02"]
                }
              ],
              "emptyDataTypes": [],
              "errors": [
                {
                  "dataType": "measures",
                  "code": "upstream_unavailable",
                  "message": "Provider request failed"
                }
              ]
            }
        """.trimIndent(),
    )

private inline fun <reified T : Any> metricListExample(): ExampleObject =
    when (T::class) {
        StepSamplesResponse::class -> stepSamplesExample()
        SleepSessionsResponse::class -> sleepSessionsExample()
        BodyMeasurementsResponse::class -> bodyMeasurementsExample()
        HeartRateSamplesResponse::class -> heartRateSamplesExample()
        DashboardSummaryResponse::class -> dashboardSummaryExample()
        else -> jsonExample("Metric response", """{"items": []}""")
    }

private fun stepSamplesExample(): ExampleObject =
    jsonExample("Step samples", """{"items":[{"id":1,"startAt":"2026-04-02T07:00:00Z","endAt":"2026-04-02T08:00:00Z","steps":1200,"source":{"provider":"withings","providerInstanceId":"withings:123456"}}]}""")

private fun stepDailySummariesExample(): ExampleObject =
    jsonExample("Daily step summaries", """{"items":[{"date":"2026-04-02","steps":8200,"sampleCount":12,"source":{"provider":"withings","providerInstanceId":"withings:123456"}}]}""")

private fun sleepSessionsExample(): ExampleObject =
    jsonExample("Sleep sessions", """{"items":[{"id":2,"startAt":"2026-04-01T22:30:00Z","endAt":"2026-04-02T06:45:00Z","durationSeconds":29700,"stages":[{"stage":"deep","startAt":"2026-04-01T23:00:00Z","endAt":"2026-04-01T23:45:00Z","durationSeconds":2700}],"source":{"provider":"withings","providerInstanceId":"withings:123456"}}]}""")

private fun sleepNightsExample(): ExampleObject =
    jsonExample("Sleep nights", """{"items":[{"date":"2026-04-02","timezone":"Europe/Berlin","session":{"id":2,"startAt":"2026-04-01T22:30:00Z","endAt":"2026-04-02T06:45:00Z","durationSeconds":29700,"stages":[],"source":{"provider":"withings","providerInstanceId":"withings:123456"}}}]}""")

internal fun bodyMeasurementsExample(): ExampleObject =
    jsonExample("Body measurements", """{"items":[{"id":3,"measuredAt":"2026-04-02T06:50:00Z","metricType":"weight_kg","value":78.4,"unit":"kg","source":{"provider":"withings","providerInstanceId":"withings:123456"}}]}""")

private fun heartRateSamplesExample(): ExampleObject =
    jsonExample("Heart-rate samples", """{"items":[{"id":4,"measuredAt":"2026-04-02T08:05:00Z","bpm":62,"context":"resting","source":{"provider":"withings","providerInstanceId":"withings:123456"}}]}""")

internal fun dashboardSummaryExample(): ExampleObject =
    jsonExample("Dashboard summary", """{"fromDate":"2026-04-01","toDate":"2026-04-07","steps":{"steps":45200,"sampleCount":84},"latestWeight":{"id":3,"measuredAt":"2026-04-02T06:50:00Z","metricType":"weight_kg","value":78.4,"unit":"kg"},"latestHeartRate":{"id":4,"measuredAt":"2026-04-02T08:05:00Z","bpm":62,"context":"resting"},"lastSleepSession":null}""")

private fun jsonExample(summary: String, json: String): ExampleObject =
    ExampleObject(
        summary = summary,
        description = "JSON example payload.",
        value = GenericElementString(json),
    )

private fun stringElement(value: String): GenericElement =
    GenericElement.encodeToElement(String.serializer(), value)

internal fun ingestionRecordSchema(): JsonSchema =
    JsonSchema(
        oneOf = listOf(
            ReferenceOr.schema("StepIntervalDto"),
            ReferenceOr.schema("SleepSessionDto"),
            ReferenceOr.schema("BodyMeasurementDto"),
            ReferenceOr.schema("HeartRateDto"),
        ),
        discriminator = JsonSchemaDiscriminator(
            propertyName = "type",
            mapping = mapOf(
                "step_interval" to "#/components/schemas/StepIntervalDto",
                "sleep_session" to "#/components/schemas/SleepSessionDto",
                "body_measurement" to "#/components/schemas/BodyMeasurementDto",
                "heart_rate" to "#/components/schemas/HeartRateDto",
            )
        ),
    )

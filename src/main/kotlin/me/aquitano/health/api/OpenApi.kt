@file:OptIn(ExperimentalKtorApi::class)

package me.aquitano.health.api

import io.ktor.http.*
import io.ktor.openapi.*
import io.ktor.server.routing.*
import io.ktor.server.routing.openapi.*
import io.ktor.utils.io.*
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer
import me.aquitano.external.google.GOOGLE_HEALTH_PROVIDER_CODE
import me.aquitano.external.withings.WITHINGS_PROVIDER_CODE
import me.aquitano.health.api.dto.*
import me.aquitano.health.domain.BodyMetricTypes
import me.aquitano.health.domain.RecordTypes
import me.aquitano.health.domain.ValidationIssueCodes
import me.aquitano.health.shared.AppJson
import kotlin.reflect.typeOf

internal const val BearerApiKeySecurityScheme = "bearerApiKey"

private const val JsonFormatDate = "date"
private const val JsonFormatDateTime = "date-time"

private const val ExampleProviderInstanceId = "$WITHINGS_PROVIDER_CODE:123456"
private const val ExampleRequestId = "test-request-123"

private const val ExampleDate = "2026-04-02"
private const val ExampleFromDate = "2026-04-01"
private const val ExampleToDate = "2026-04-07"
private const val ExampleFromAt = "${ExampleFromDate}T00:00:00Z"
private const val ExampleToAt = "${ExampleDate}T00:00:00Z"
private const val ExampleIngestedAt = "${ExampleDate}T08:15:30Z"
private const val ExampleBatchExternalId =
    "$WITHINGS_PROVIDER_CODE-$ExampleToAt"
private const val ExampleStepStartAt = "${ExampleDate}T07:00:00Z"
private const val ExampleStepEndAt = "${ExampleDate}T08:00:00Z"
private const val ExampleSleepStartAt = "${ExampleFromDate}T22:30:00Z"
private const val ExampleSleepEndAt = "${ExampleDate}T06:45:00Z"
private const val ExampleSleepStageStartAt = "${ExampleFromDate}T23:00:00Z"
private const val ExampleSleepStageEndAt = "${ExampleFromDate}T23:45:00Z"
private const val ExampleBodyMeasuredAt = "${ExampleDate}T06:50:00Z"
private const val ExampleHeartRateMeasuredAt = "${ExampleDate}T08:05:00Z"

private const val StepIntervalSchemaName = "StepIntervalDto"
private const val SleepSessionSchemaName = "SleepSessionDto"
private const val BodyMeasurementSchemaName = "BodyMeasurementDto"
private const val HeartRateSchemaName = "HeartRateDto"

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
            Server(
                url = "http://localhost:8080",
                description = "Local development"
            ),
        ),
        paths = emptyMap(),
        webhooks = emptyMap(),
        components = openApiComponents(),
        security = listOf(mapOf(BearerApiKeySecurityScheme to emptyList())),
        tags = listOf(
            Tag("Admin", "Health checks and ingestion administration."),
            Tag(
                "Ingestion",
                "Normalized health batch ingestion for trusted clients and provider adapters."
            ),
            Tag(
                "Providers",
                "Provider discovery, OAuth connection, status, and synchronization workflows."
            ),
            Tag(
                "Read",
                "Metric catalog and read endpoints for health data queries."
            ),
        ),
        externalDocs = null,
        extensions = emptyMap(),
    )

internal fun stripInferredAuthorizationParameters(content: String): String {
    val root = runCatching { AppJson.parseToJsonElement(content).jsonObject }
        .getOrElse { return content }
    val paths = root["paths"]?.jsonObject ?: return content
    val sanitizedPaths = JsonObject(
        paths.mapValues { (_, pathItem) ->
            JsonObject(
                pathItem.jsonObject.mapValues { (_, operation) ->
                    sanitizeOperation(operation)
                }
            )
        }
    )
    val sanitizedRoot = JsonObject(
        root.toMutableMap().also { it["paths"] = sanitizedPaths }
    )
    return sanitizedRoot.toString()
}

private fun sanitizeOperation(operation: JsonElement): JsonElement {
    if (operation !is JsonObject) return operation
    val operationObject = operation.jsonObject
    val parameters = operationObject["parameters"]?.jsonArray ?: return operation
    val sanitizedParameters = JsonArray(
        parameters.filterNot { parameter ->
            val parameterObject = parameter.jsonObject
            parameterObject["name"]?.jsonPrimitive?.content == "Authorization" &&
                    parameterObject["in"]?.jsonPrimitive?.content == "header"
        }
    )
    return JsonObject(
        operationObject.toMutableMap().also { operation ->
            if (sanitizedParameters.isEmpty()) {
                operation.remove("parameters")
            } else {
                operation["parameters"] = sanitizedParameters
            }
        }
    )
}

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
                validationErrorExample()
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
    require((exampleName == null) == (example == null)) {
        "exampleName and example must either both be set or both be null."
    }

    requestBody {
        description = descriptionText
        required = true
        content {
            schema = buildSchema(typeOf<T>())

            if (exampleName != null && example != null) {
                example(exampleName, example)
            }
        }
    }
}

internal fun Operation.Builder.ingestionBatchJsonRequest() {
    requestBody {
        description =
            "Normalized ingestion batch. Fields are nullable at the transport layer where provider adapters may omit them, but validation enforces provider, providerInstanceId, batch identity, and record-specific required fields."
        required = true
        content {
            schema = JsonSchema(
                type = JsonType.OBJECT,
                properties = mapOf(
                    "provider" to ReferenceOr.Value(stringSchema(example = WITHINGS_PROVIDER_CODE)),
                    "providerInstanceId" to ReferenceOr.Value(
                        stringSchema(
                            example = ExampleProviderInstanceId
                        )
                    ),
                    "batchExternalId" to ReferenceOr.Value(stringSchema(example = ExampleBatchExternalId)),
                    "ingestedAt" to ReferenceOr.Value(
                        stringSchema(
                            format = JsonFormatDateTime,
                            example = ExampleIngestedAt
                        )
                    ),
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

internal fun Responses.Builder.defaultError() {
    default {
        description = "Error response"
        content {
            schema = buildSchema(typeOf<ErrorResponse>())
            example(
                "error",
                internalErrorExample()
            )
        }
    }
}

internal fun Responses.Builder.commonErrors(
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
            content {
                schema = buildSchema(typeOf<ErrorResponse>())
                example("validation", validationErrorExample())
            }
        }
    }
    if (unauthorized) {
        HttpStatusCode.Unauthorized {
            description = "Missing or invalid API key"
            content {
                schema = buildSchema(typeOf<ErrorResponse>())
                example("unauthorized", unauthorizedErrorExample())
            }
        }
    }
    if (notFound) {
        HttpStatusCode.NotFound {
            description = "Resource not found"
            content {
                schema = buildSchema(typeOf<ErrorResponse>())
                example("notFound", notFoundErrorExample())
            }
        }
    }
    if (conflict) {
        HttpStatusCode.Conflict {
            description = "Request conflicts with current state"
            content {
                schema = buildSchema(typeOf<ErrorResponse>())
                example("conflict", conflictErrorExample())
            }
        }
    }
    if (upstream) {
        HttpStatusCode.BadGateway {
            description = "Upstream provider request failed"
            content {
                schema = buildSchema(typeOf<ErrorResponse>())
                example("upstream", upstreamErrorExample())
            }
        }
    }
    if (internal) {
        HttpStatusCode.InternalServerError {
            description = "Unexpected server error"
            content {
                schema = buildSchema(typeOf<ErrorResponse>())
                example("internal", internalErrorExample())
            }
        }
    }
}

internal fun Operation.Builder.providerCodePath() {
    parameters {
        path("providerCode") {
            description =
                "Provider code. Current examples are `google-health` and `withings`."
            schema = stringSchema(
                enumValues = listOf(
                    GOOGLE_HEALTH_PROVIDER_CODE,
                    WITHINGS_PROVIDER_CODE
                ), example = WITHINGS_PROVIDER_CODE
            )
        }
    }
}

internal fun Operation.Builder.readQueryParameters(includeLatest: Boolean = false) {
    parameters {
        query("from") {
            description =
                "Inclusive start timestamp or date. Date-only values are interpreted by the endpoint's query service."
            schema = stringSchema(
                format = JsonFormatDateTime,
                example = ExampleFromAt
            )
        }
        query("to") {
            description =
                "Exclusive end timestamp or date. Date-only values are interpreted by the endpoint's query service."
            schema =
                stringSchema(format = JsonFormatDateTime, example = ExampleToAt)
        }
        query("provider") {
            description = "Source provider filter."
            schema = stringSchema(example = WITHINGS_PROVIDER_CODE)
        }
        query("providerInstanceId") {
            description = "Source provider account or instance filter."
            schema = stringSchema(example = ExampleProviderInstanceId)
        }
        query("includeSource") {
            description =
                "Include source provider metadata in each item. Defaults to false."
            schema = booleanSchema(default = false, example = false)
        }
        if (includeLatest) {
            query("latest") {
                description =
                    "Return the latest matching item when true. Defaults to false. Cannot be combined with limit, sort, or order."
                schema = booleanSchema(default = false, example = true)
            }
        }
        query("sort") {
            description =
                "Sort field for this endpoint. Each metric endpoint supports its documented default temporal or date field."
            schema = stringSchema(example = "measuredAt")
        }
        query("order") {
            description =
                "Sort direction. Defaults to asc. Use desc for newest-first reads."
            schema = stringSchema(
                enumValues = listOf("asc", "desc"),
                default = "asc",
                example = "desc",
            )
        }
        query("limit") {
            description =
                "Maximum number of items. Defaults to 500 and cannot exceed 5000."
            schema = integerSchema(
                default = 500,
                minimum = 1.0,
                maximum = 5000.0,
                example = 100
            )
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
            description =
                "Exact sleep night date or `today`. Matches the localized date of session endAt and cannot be combined with fromDate or toDate."
            schema =
                stringSchema(format = JsonFormatDate, example = ExampleDate)
        }
        query("fromDate") {
            description =
                "Inclusive local sleep-night start date based on session endAt."
            schema =
                stringSchema(format = JsonFormatDate, example = ExampleFromDate)
        }
        query("toDate") {
            description =
                "Inclusive local sleep-night end date based on session endAt."
            schema =
                stringSchema(format = JsonFormatDate, example = ExampleToDate)
        }
        query("timezone") {
            description =
                "IANA timezone used to classify endAt dates. Defaults to UTC."
            schema = stringSchema(example = "Europe/Berlin")
        }
        query("provider") {
            description = "Source provider filter."
            schema = stringSchema(example = WITHINGS_PROVIDER_CODE)
        }
        query("providerInstanceId") {
            description = "Source provider account or instance filter."
            schema = stringSchema(example = ExampleProviderInstanceId)
        }
        query("includeSource") {
            description =
                "Include source provider metadata in each item. Defaults to false."
            schema = booleanSchema(default = false, example = false)
        }
        query("limit") {
            description =
                "Maximum number of items. Defaults to 500, cannot exceed 5000, and is ignored as 1 when date is provided."
            schema = integerSchema(
                default = 500,
                minimum = 1.0,
                maximum = 5000.0,
                example = 7
            )
        }
        query("sort") {
            description = "Sort field. Sleep night reads support `date`."
            schema = stringSchema(
                enumValues = listOf("date"),
                default = "date",
                example = "date",
            )
        }
        query("order") {
            description =
                "Sort direction. Defaults to asc. Use desc for most recent sleep nights first."
            schema = stringSchema(
                enumValues = listOf("asc", "desc"),
                default = "asc",
                example = "desc",
            )
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

internal fun Operation.Builder.bodyMeasurementLatestQueryParameters() {
    parameters {
        query("from") {
            description = "Inclusive start timestamp."
            schema = stringSchema(
                format = JsonFormatDateTime,
                example = ExampleFromAt
            )
        }
        query("to") {
            description = "Exclusive end timestamp."
            schema =
                stringSchema(format = JsonFormatDateTime, example = ExampleToAt)
        }
        query("provider") {
            description = "Source provider filter."
            schema = stringSchema(example = WITHINGS_PROVIDER_CODE)
        }
        query("providerInstanceId") {
            description = "Source provider account or instance filter."
            schema = stringSchema(example = ExampleProviderInstanceId)
        }
        query("includeSource") {
            description =
                "Include source provider metadata in the returned item. Defaults to false."
            schema = booleanSchema(default = false, example = false)
        }
        query("metricType") {
            description = "Required body measurement type filter."
            required = true
            schema = stringSchema(
                enumValues = BodyMetricTypes.supported.sorted(),
                example = BodyMetricTypes.WEIGHT,
            )
        }
    }
}

internal fun Operation.Builder.heartRateSummaryQueryParameters() {
    parameters {
        query("from") {
            description = "Inclusive start timestamp."
            schema = stringSchema(
                format = JsonFormatDateTime,
                example = ExampleFromAt
            )
        }
        query("to") {
            description = "Exclusive end timestamp."
            schema =
                stringSchema(format = JsonFormatDateTime, example = ExampleToAt)
        }
        query("provider") {
            description = "Source provider filter."
            schema = stringSchema(example = WITHINGS_PROVIDER_CODE)
        }
        query("providerInstanceId") {
            description = "Source provider account or instance filter."
            schema = stringSchema(example = ExampleProviderInstanceId)
        }
        query("includeSource") {
            description =
                "Include source provider metadata in the nested latest item. Defaults to false."
            schema = booleanSchema(default = false, example = false)
        }
    }
}

internal fun Operation.Builder.dashboardQueryParameters() {
    parameters {
        query("fromDate") {
            description = "Inclusive UTC start date for dashboard summaries."
            required = true
            schema =
                stringSchema(format = JsonFormatDate, example = ExampleFromDate)
        }
        query("toDate") {
            description = "Inclusive UTC end date for dashboard summaries."
            required = true
            schema =
                stringSchema(format = JsonFormatDate, example = ExampleToDate)
        }
        query("provider") {
            description =
                "Source provider filter applied to summary metric lookups."
            schema = stringSchema(example = WITHINGS_PROVIDER_CODE)
        }
        query("providerInstanceId") {
            description =
                "Source provider account or instance filter applied to summary metric lookups."
            schema = stringSchema(example = ExampleProviderInstanceId)
        }
        query("includeSource") {
            description =
                "Include source provider metadata for nested latest items. Defaults to false."
            schema = booleanSchema(default = false, example = false)
        }
    }
}

internal fun Operation.Builder.healthDayQueryParameters() {
    parameters {
        query("date") {
            description = "Required local date in YYYY-MM-DD format or `today`."
            required = true
            schema = stringSchema(format = JsonFormatDate, example = ExampleDate)
        }
        query("timezone") {
            description = "IANA timezone used to convert the local day into UTC boundaries. Defaults to UTC."
            schema = stringSchema(default = "UTC", example = "Europe/Berlin")
        }
        query("modules") {
            description = "Required comma-separated module list. Supported values: steps, heartRate, weight, sleep."
            required = true
            schema = stringSchema(example = "steps,heartRate,weight,sleep")
        }
        query("provider") {
            description = "Source provider filter."
            schema = stringSchema(example = WITHINGS_PROVIDER_CODE)
        }
        query("providerInstanceId") {
            description = "Source provider account or instance filter."
            schema = stringSchema(example = ExampleProviderInstanceId)
        }
        query("includeSource") {
            description = "Include source provider metadata on point-level objects where available. Defaults to false."
            schema = booleanSchema(default = false, example = false)
        }
    }
}

internal fun Operation.Builder.adminQueryParameters() {
    parameters {
        query("status") {
            description = "Batch status filter."
            schema = stringSchema(
                enumValues = listOf(
                    "accepted",
                    "failed",
                    "duplicate"
                ), example = "failed"
            )
        }
        query("from") {
            description = "Inclusive received-at start timestamp."
            schema = stringSchema(
                format = JsonFormatDateTime,
                example = ExampleFromAt
            )
        }
        query("to") {
            description = "Exclusive received-at end timestamp."
            schema =
                stringSchema(format = JsonFormatDateTime, example = ExampleToAt)
        }
        query("limit") {
            description =
                "Maximum number of items. Defaults to 100 and cannot exceed 1000 for admin list endpoints."
            schema = integerSchema(
                default = 100,
                minimum = 1.0,
                maximum = 1000.0,
                example = 50
            )
        }
    }
}

private fun Operation.Builder.dateRangeQueryParameters(label: String) {
    parameters {
        query("date") {
            description =
                "Exact $label or `today`. Cannot be combined with fromDate or toDate."
            schema =
                stringSchema(format = JsonFormatDate, example = ExampleDate)
        }
        query("fromDate") {
            description = "Inclusive $label start date."
            schema =
                stringSchema(format = JsonFormatDate, example = ExampleFromDate)
        }
        query("toDate") {
            description = "Inclusive $label end date."
            schema =
                stringSchema(format = JsonFormatDate, example = ExampleToDate)
        }
    }
}

internal fun Route.describeReadOperation(
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
    errorResponses()
}

internal fun Route.describeDailyStepReadOperation(): Route = describe {
    operationId = "listDailyStepSummaries"
    tag("Read")
    summary = "List daily step summaries"
    description =
        "Returns daily UTC step totals. Use `date` for one day, or `fromDate` and `toDate` for an inclusive date range. `from` and `to` are also accepted by the shared query parser for timestamp-style filters."
    requiresBearerAuth()
    dailyStepQueryParameters()
    errorResponses()
}

internal fun Route.describeSleepNightReadOperation(): Route = describe {
    operationId = "listSleepNights"
    tag("Read")
    summary = "List sleep nights"
    description =
        "Returns sleep sessions classified by the localized date of `endAt`. Use `timezone` to control night boundaries."
    requiresBearerAuth()
    sleepNightQueryParameters()
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
        default = default?.let {
            GenericElement.encodeToElement(
                Int.serializer(),
                it
            )
        },
        minimum = minimum,
        maximum = maximum,
        example = example?.let {
            GenericElement.encodeToElement(
                Int.serializer(),
                it
            )
        },
    )

internal fun booleanSchema(
    default: Boolean? = null,
    example: Boolean? = null
): JsonSchema =
    JsonSchema(
        type = JsonType.BOOLEAN,
        default = default?.let {
            GenericElement.encodeToElement(
                Boolean.serializer(),
                it
            )
        },
        example = example?.let {
            GenericElement.encodeToElement(
                Boolean.serializer(),
                it
            )
        },
    )

internal fun ingestionBatchExample(): ExampleObject =
    jsonExample(
        summary = "Batch with normalized records",
        value = IngestionBatchRequest(
            provider = WITHINGS_PROVIDER_CODE,
            providerInstanceId = ExampleProviderInstanceId,
            batchExternalId = ExampleBatchExternalId,
            ingestedAt = ExampleIngestedAt,
            sourcePayload = buildJsonObject {
                put("job", JsonPrimitive("daily-sync"))
            },
            records = listOf(
                StepIntervalDto(
                    providerRecordId = "steps-1",
                    startAt = ExampleStepStartAt,
                    endAt = ExampleStepEndAt,
                    steps = 1200,
                ),
                SleepSessionDto(
                    providerRecordId = "sleep-1",
                    startAt = ExampleSleepStartAt,
                    endAt = ExampleSleepEndAt,
                    stages = listOf(
                        SleepStageDto(
                            stage = "deep",
                            startAt = ExampleSleepStageStartAt,
                            endAt = ExampleSleepStageEndAt,
                        )
                    ),
                ),
                BodyMeasurementDto(
                    providerRecordId = "weight-1",
                    measuredAt = ExampleBodyMeasuredAt,
                    weightKg = 78.4,
                ),
                HeartRateDto(
                    providerRecordId = "hr-1",
                    measuredAt = ExampleHeartRateMeasuredAt,
                    bpm = 62,
                    context = "resting",
                ),
            ),
        ),
    )

internal fun ingestionSummaryExample(duplicate: Boolean = false): ExampleObject =
    jsonExample(
        summary = if (duplicate) "Duplicate batch" else "Created batch",
        value = IngestionSummaryResponse(
            batchId = 42,
            status = "accepted",
            duplicateBatch = duplicate,
            recordsReceived = 4,
            ingestionRecordsStored = if (duplicate) 0 else 4,
            metricsCreated = MetricCreatedCountsResponse(
                stepSamples = if (duplicate) 0 else 1,
                sleepSessions = if (duplicate) 0 else 1,
                sleepStages = if (duplicate) 0 else 1,
                bodyMeasurements = if (duplicate) 0 else 1,
                heartRateSamples = if (duplicate) 0 else 1,
            ),
            metricsSkipped = MetricSkippedCountsResponse(
                duplicates = if (duplicate) 4 else 0,
            ),
            affectedStepSummaryDates = listOf(ExampleDate),
        ),
    )

internal fun providerSyncRequestExample(): ExampleObject =
    jsonExample(
        summary = "Provider sync request",
        value = ProviderSyncRequestDto(
            providerInstanceId = ExampleProviderInstanceId,
            from = ExampleFromAt,
            to = ExampleToAt,
            dataTypes = listOf("activity", "measures"),
            pageSize = 100,
        ),
    )

internal fun healthResponseExample(): ExampleObject =
    jsonExample(
        summary = "Health status",
        value = HealthResponse(
            status = "ok",
            service = "aqt-health",
            time = ExampleIngestedAt,
        ),
    )

private fun validationErrorExample(): ExampleObject =
    jsonExample(
        summary = "Validation failed",
        value = ErrorResponse(
            ErrorBody(
                code = "validation_failed",
                message = "Request validation failed",
                requestId = ExampleRequestId,
                details = listOf(
                    ErrorDetail(
                        field = "fromDate",
                        code = ValidationIssueCodes.InvalidFormat,
                        message = "must be an ISO-8601 date",
                    ),
                    ErrorDetail(
                        field = "toDate",
                        code = ValidationIssueCodes.InvalidRange,
                        message = "must be on or after fromDate",
                    ),
                ),
            )
        ),
    )

private fun unauthorizedErrorExample(): ExampleObject =
    jsonExample(
        summary = "Unauthorized",
        value = ErrorResponse(
            ErrorBody(
                code = "unauthorized",
                message = "Missing or invalid API key",
                requestId = ExampleRequestId,
            )
        ),
    )

private fun notFoundErrorExample(): ExampleObject =
    jsonExample(
        summary = "Not found",
        value = ErrorResponse(
            ErrorBody(
                code = "not_found",
                message = "Provider '$WITHINGS_PROVIDER_CODE' not found",
                requestId = ExampleRequestId,
            )
        ),
    )

private fun conflictErrorExample(): ExampleObject =
    jsonExample(
        summary = "Conflict",
        value = ErrorResponse(
            ErrorBody(
                code = "ingestion_batch_in_progress",
                message = "Batch '$ExampleBatchExternalId' already exists with status 'accepted'",
                requestId = ExampleRequestId,
            )
        ),
    )

private fun upstreamErrorExample(): ExampleObject =
    jsonExample(
        summary = "Upstream provider failure",
        value = ErrorResponse(
            ErrorBody(
                code = "upstream_unavailable",
                message = "Provider request failed",
                requestId = ExampleRequestId,
            )
        ),
    )

private fun internalErrorExample(): ExampleObject =
    jsonExample(
        summary = "Internal server error",
        value = ErrorResponse(
            ErrorBody(
                code = "internal_error",
                message = "Unexpected server error",
                requestId = ExampleRequestId,
            )
        ),
    )

private inline fun <reified T> jsonExample(
    summary: String,
    value: T
): ExampleObject =
    ExampleObject(
        summary = summary,
        value = GenericElement(
            AppJson.encodeToJsonElement(
                serializer<T>(),
                value
            )
        ),
    )

private fun stringElement(value: String): GenericElement =
    GenericElement.encodeToElement(String.serializer(), value)

internal fun ingestionRecordSchema(): JsonSchema =
    JsonSchema(
        oneOf = listOf(
            ReferenceOr.schema(StepIntervalSchemaName),
            ReferenceOr.schema(SleepSessionSchemaName),
            ReferenceOr.schema(BodyMeasurementSchemaName),
            ReferenceOr.schema(HeartRateSchemaName),
        ),
        discriminator = JsonSchemaDiscriminator(
            propertyName = "type",
            mapping = mapOf(
                RecordTypes.STEP_INTERVAL to componentSchemaRef(
                    StepIntervalSchemaName
                ),
                RecordTypes.SLEEP_SESSION to componentSchemaRef(
                    SleepSessionSchemaName
                ),
                RecordTypes.BODY_MEASUREMENT to componentSchemaRef(
                    BodyMeasurementSchemaName
                ),
                RecordTypes.HEART_RATE to componentSchemaRef(HeartRateSchemaName),
            )
        ),
    )

private fun componentSchemaRef(schemaName: String): String =
    "#/components/schemas/$schemaName"

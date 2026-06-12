@file:OptIn(ExperimentalKtorApi::class)

package me.aquitano.health.api

import io.ktor.openapi.*
import io.ktor.utils.io.*
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.serializer
import me.aquitano.external.withings.WITHINGS_PROVIDER_CODE
import me.aquitano.health.api.dto.*
import me.aquitano.health.domain.ValidationIssueCodes
import me.aquitano.health.shared.AppJson

internal const val ExampleProviderInstanceId = "$WITHINGS_PROVIDER_CODE:123456"
internal const val ExampleRequestId = "test-request-123"

internal const val ExampleDate = "2026-04-02"
internal const val ExampleFromDate = "2026-04-01"
internal const val ExampleToDate = "2026-04-07"
internal const val ExampleFromAt = "${ExampleFromDate}T00:00:00Z"
internal const val ExampleToAt = "${ExampleDate}T00:00:00Z"
internal const val ExampleIngestedAt = "${ExampleDate}T08:15:30Z"
internal const val ExampleBatchExternalId =
    "$WITHINGS_PROVIDER_CODE-$ExampleToAt"
internal const val ExampleStepStartAt = "${ExampleDate}T07:00:00Z"
internal const val ExampleStepEndAt = "${ExampleDate}T08:00:00Z"
internal const val ExampleSleepStartAt = "${ExampleFromDate}T22:30:00Z"
internal const val ExampleSleepEndAt = "${ExampleDate}T06:45:00Z"
internal const val ExampleSleepStageStartAt = "${ExampleFromDate}T23:00:00Z"
internal const val ExampleSleepStageEndAt = "${ExampleFromDate}T23:45:00Z"
internal const val ExampleBodyMeasuredAt = "${ExampleDate}T06:50:00Z"
internal const val ExampleHeartRateMeasuredAt = "${ExampleDate}T08:05:00Z"
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
            status = BatchStatus.Processed,
            duplicateBatch = duplicate,
            recordsReceived = 4,
            ingestionRecordsStored = if (duplicate) 0 else 4,
            metricsCreated = if (duplicate) {
                emptyMap()
            } else {
                mapOf(
                    "step_samples" to 1,
                    "sleep_sessions" to 1,
                    "sleep_stages" to 1,
                    "heart_rate" to 1,
                )
            },
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

internal fun validationErrorExample(): ExampleObject =
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

internal fun unauthorizedErrorExample(): ExampleObject =
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

internal fun notFoundErrorExample(): ExampleObject =
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

internal fun conflictErrorExample(): ExampleObject =
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

internal fun upstreamErrorExample(): ExampleObject =
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

internal fun internalErrorExample(): ExampleObject =
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

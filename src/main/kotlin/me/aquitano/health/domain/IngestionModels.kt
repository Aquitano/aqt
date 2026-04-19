package me.aquitano.health.domain

import kotlinx.serialization.json.JsonElement
import java.time.Instant
import java.time.LocalDate

data class ValidatedIngestionBatch(
    val provider: String,
    val providerInstanceId: String,
    val batchExternalId: String?,
    val ingestedAt: Instant,
    val sourcePayload: JsonElement,
    val normalizedPayloadJson: String,
    val records: List<HealthRecord>,
)

data class MetricCreatedCounts(
    val stepSamples: Int = 0,
    val sleepSessions: Int = 0,
    val sleepStages: Int = 0,
    val bodyMeasurements: Int = 0,
    val heartRateSamples: Int = 0,
) {
    operator fun plus(other: MetricCreatedCounts): MetricCreatedCounts =
        MetricCreatedCounts(
            stepSamples = stepSamples + other.stepSamples,
            sleepSessions = sleepSessions + other.sleepSessions,
            sleepStages = sleepStages + other.sleepStages,
            bodyMeasurements = bodyMeasurements + other.bodyMeasurements,
            heartRateSamples = heartRateSamples + other.heartRateSamples,
        )
}

data class IngestionSummary(
    val batchId: Int,
    val status: String,
    val duplicateBatch: Boolean,
    val recordsReceived: Int,
    val ingestionRecordsStored: Int,
    val metricsCreated: MetricCreatedCounts,
    val duplicateMetricsSkipped: Int,
    val affectedStepSummaryDates: List<LocalDate>,
)

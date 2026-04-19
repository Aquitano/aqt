package me.aquitano.health.domain

import kotlinx.serialization.json.JsonElement
import java.time.Instant
import java.time.LocalDate

data class ValidatedIngestionBatch(
    val provider: String,
    val providerInstanceId: String,
    val batchExternalId: String?,
    val ingestedAt: Instant,
    val rawPayload: JsonElement,
    val mappedPayloadJson: String,
    val records: List<CanonicalRecord>,
)

data class CanonicalCreatedCounts(
    val stepSamples: Int = 0,
    val sleepSessions: Int = 0,
    val sleepStages: Int = 0,
    val bodyMeasurements: Int = 0,
    val heartRateSamples: Int = 0,
) {
    operator fun plus(other: CanonicalCreatedCounts): CanonicalCreatedCounts =
        CanonicalCreatedCounts(
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
    val rawRecordsStored: Int,
    val canonicalRecordsCreated: CanonicalCreatedCounts,
    val duplicateCanonicalRecordsSkipped: Int,
    val affectedStepSummaryDates: List<LocalDate>,
)

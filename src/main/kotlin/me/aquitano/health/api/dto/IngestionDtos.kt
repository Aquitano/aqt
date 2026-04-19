package me.aquitano.health.api.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

@Serializable
data class IngestionBatchRequest(
    val provider: String? = null,
    val providerInstanceId: String? = null,
    val batchExternalId: String? = null,
    val ingestedAt: String? = null,
    val rawPayload: JsonElement? = null,
    val records: List<JsonObject>? = null,
)

@Serializable
data class IngestionSummaryResponse(
    val batchId: Int,
    val status: String,
    val duplicateBatch: Boolean,
    val recordsReceived: Int,
    val rawRecordsStored: Int,
    val canonicalRecordsCreated: CanonicalCreatedCountsResponse,
    val canonicalRecordsSkipped: CanonicalSkippedCountsResponse,
    val affectedStepSummaryDates: List<String>,
)

@Serializable
data class CanonicalCreatedCountsResponse(
    val stepSamples: Int,
    val sleepSessions: Int,
    val sleepStages: Int,
    val bodyMeasurements: Int,
    val heartRateSamples: Int,
)

@Serializable
data class CanonicalSkippedCountsResponse(
    val duplicates: Int,
)

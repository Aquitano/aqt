package me.aquitano.health.api.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

@Serializable
data class IngestionBatchRequest(
    val provider: String? = null,
    val providerInstanceId: String? = null,
    val batchExternalId: String? = null,
    val ingestedAt: String? = null,
    val sourcePayload: JsonElement? = null,
    val records: List<IngestionRecordDto>? = null,
)

@Serializable
sealed class IngestionRecordDto {
    abstract val providerRecordId: String?
}

@Serializable
@SerialName("step_interval")
data class StepIntervalDto(
    override val providerRecordId: String? = null,
    val startAt: String,
    val endAt: String,
    val steps: Int,
) : IngestionRecordDto()

@Serializable
@SerialName("sleep_session")
data class SleepSessionDto(
    override val providerRecordId: String? = null,
    val startAt: String,
    val endAt: String,
    val stages: List<SleepStageDto> = emptyList(),
) : IngestionRecordDto()

@Serializable
data class SleepStageDto(
    val stage: String,
    val startAt: String,
    val endAt: String,
)

@Serializable
@SerialName("body_measurement")
data class BodyMeasurementDto(
    override val providerRecordId: String? = null,
    val measuredAt: String,
    val weightKg: Double? = null,
    val bodyFatPercent: Double? = null,
    val muscleKg: Double? = null,
    val waterPercent: Double? = null,
    val visceralFatRating: Double? = null,
) : IngestionRecordDto()

@Serializable
@SerialName("heart_rate")
data class HeartRateDto(
    override val providerRecordId: String? = null,
    val measuredAt: String,
    val bpm: Int,
    val context: String? = null,
) : IngestionRecordDto()

@Serializable
data class IngestionSummaryResponse(
    val batchId: Int,
    val status: String,
    val duplicateBatch: Boolean,
    val recordsReceived: Int,
    val ingestionRecordsStored: Int,
    val metricsCreated: MetricCreatedCountsResponse,
    val metricsSkipped: MetricSkippedCountsResponse,
    val affectedStepSummaryDates: List<String>,
)

@Serializable
data class MetricCreatedCountsResponse(
    val stepSamples: Int,
    val sleepSessions: Int,
    val sleepStages: Int,
    val bodyMeasurements: Int,
    val heartRateSamples: Int,
)

@Serializable
data class MetricSkippedCountsResponse(
    val duplicates: Int,
)

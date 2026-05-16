package me.aquitano.health.api.dto

import io.ktor.openapi.JsonSchema
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class IngestionBatchRequest(
    val provider: String? = null,
    val providerInstanceId: String? = null,
    val batchExternalId: String? = null,
    @JsonSchema.Format("date-time")
    val ingestedAt: String? = null,
    val sourcePayload: JsonElement? = null,
    val records: List<IngestionRecordDto>? = null,
)

@Serializable
@JsonSchema.OneOf(StepIntervalDto::class, SleepSessionDto::class, BodyMeasurementDto::class, HeartRateDto::class)
@JsonSchema.Discriminator(
    "type",
    JsonSchema.Discriminator.Mapping("step_interval", StepIntervalDto::class),
    JsonSchema.Discriminator.Mapping("sleep_session", SleepSessionDto::class),
    JsonSchema.Discriminator.Mapping("body_measurement", BodyMeasurementDto::class),
    JsonSchema.Discriminator.Mapping("heart_rate", HeartRateDto::class),
)
sealed class IngestionRecordDto {
    abstract val providerRecordId: String?
}

@Serializable
@SerialName("step_interval")
data class StepIntervalDto(
    override val providerRecordId: String? = null,
    @JsonSchema.Format("date-time")
    val startAt: String,
    @JsonSchema.Format("date-time")
    val endAt: String,
    val steps: Int,
) : IngestionRecordDto()

@Serializable
@SerialName("sleep_session")
data class SleepSessionDto(
    override val providerRecordId: String? = null,
    @JsonSchema.Format("date-time")
    val startAt: String,
    @JsonSchema.Format("date-time")
    val endAt: String,
    val stages: List<SleepStageDto> = emptyList(),
) : IngestionRecordDto()

@Serializable
data class SleepStageDto(
    val stage: String,
    @JsonSchema.Format("date-time")
    val startAt: String,
    @JsonSchema.Format("date-time")
    val endAt: String,
)

@Serializable
@SerialName("body_measurement")
data class BodyMeasurementDto(
    override val providerRecordId: String? = null,
    @JsonSchema.Format("date-time")
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
    @JsonSchema.Format("date-time")
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
    @JsonSchema.ItemsRef(String::class)
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

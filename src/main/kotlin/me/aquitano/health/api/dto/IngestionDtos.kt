package me.aquitano.health.api.dto

import io.ktor.openapi.*
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNames
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
@JsonSchema.OneOf(
    StepIntervalDto::class,
    SleepSessionDto::class,
    BodyMeasurementDto::class,
    HeartRateDto::class,
    ActivitySummaryDto::class,
    SleepSummaryDto::class,
    RespiratoryRateDto::class,
    HrvDto::class,
    BloodPressureDto::class,
    CardiovascularDto::class,
    ExtendedBodyMeasurementDto::class,
)
@JsonSchema.Discriminator(
    "type",
    JsonSchema.Discriminator.Mapping("step_interval", StepIntervalDto::class),
    JsonSchema.Discriminator.Mapping("sleep_session", SleepSessionDto::class),
    JsonSchema.Discriminator.Mapping(
        "body_measurement",
        BodyMeasurementDto::class
    ),
    JsonSchema.Discriminator.Mapping("heart_rate", HeartRateDto::class),
    JsonSchema.Discriminator.Mapping("activity_summary", ActivitySummaryDto::class),
    JsonSchema.Discriminator.Mapping("sleep_summary", SleepSummaryDto::class),
    JsonSchema.Discriminator.Mapping("respiratory_rate", RespiratoryRateDto::class),
    JsonSchema.Discriminator.Mapping("hrv", HrvDto::class),
    JsonSchema.Discriminator.Mapping("blood_pressure", BloodPressureDto::class),
    JsonSchema.Discriminator.Mapping("cardiovascular", CardiovascularDto::class),
    JsonSchema.Discriminator.Mapping(
        "extended_body_measurement",
        ExtendedBodyMeasurementDto::class
    ),
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
    @OptIn(ExperimentalSerializationApi::class)
    @JsonNames("waterPercent")
    val bodyWaterPercent: Double? = null,
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
@SerialName("activity_summary")
data class ActivitySummaryDto(
    override val providerRecordId: String? = null,
    @JsonSchema.Format("date")
    val date: String,
    val distanceMeters: Double? = null,
    val activeEnergyKcal: Double? = null,
    val totalEnergyKcal: Double? = null,
    val elevationMeters: Double? = null,
    val softMinutes: Int? = null,
    val moderateMinutes: Int? = null,
    val intenseMinutes: Int? = null,
    val activeMinutes: Int? = null,
    val averageHeartRateBpm: Int? = null,
    val minHeartRateBpm: Int? = null,
    val maxHeartRateBpm: Int? = null,
) : IngestionRecordDto()

@Serializable
@SerialName("sleep_summary")
data class SleepSummaryDto(
    override val providerRecordId: String? = null,
    @JsonSchema.Format("date-time")
    val startAt: String,
    @JsonSchema.Format("date-time")
    val endAt: String,
    val timeInBedSeconds: Long? = null,
    val totalSleepSeconds: Long? = null,
    val lightSleepSeconds: Long? = null,
    val deepSleepSeconds: Long? = null,
    val remSleepSeconds: Long? = null,
    val sleepEfficiencyPercent: Double? = null,
    val sleepLatencySeconds: Long? = null,
    val wakeupLatencySeconds: Long? = null,
    val wakeupDurationSeconds: Long? = null,
    val wakeupCount: Int? = null,
    val wasoSeconds: Long? = null,
    val sleepScore: Int? = null,
    val remEpisodesCount: Int? = null,
    val outOfBedCount: Int? = null,
    val awakeDurationSeconds: Long? = null,
    val overnightHrvRmssd: Double? = null,
    val respiratoryRhythm: Double? = null,
    val breathingQuality: Int? = null,
    val snoringDurationSeconds: Long? = null,
    val apneaHypopneaIndex: Double? = null,
    val movementScore: Double? = null,
    val snoringEpisodeCount: Int? = null,
    val hrAverageBpm: Int? = null,
    val hrMinBpm: Int? = null,
    val hrMaxBpm: Int? = null,
    val rrAverage: Double? = null,
    val rrMin: Double? = null,
    val rrMax: Double? = null,
) : IngestionRecordDto()

@Serializable
@SerialName("respiratory_rate")
data class RespiratoryRateDto(
    override val providerRecordId: String? = null,
    @JsonSchema.Format("date-time")
    val measuredAt: String,
    val breathsPerMinute: Int,
    val context: String? = null,
) : IngestionRecordDto()

@Serializable
@SerialName("hrv")
data class HrvDto(
    override val providerRecordId: String? = null,
    @JsonSchema.Format("date-time")
    val measuredAt: String,
    val metricType: String,
    val value: Double,
    val unit: String,
    val context: String? = null,
) : IngestionRecordDto()

@Serializable
@SerialName("blood_pressure")
data class BloodPressureDto(
    override val providerRecordId: String? = null,
    @JsonSchema.Format("date-time")
    val measuredAt: String,
    val systolicMmhg: Int,
    val diastolicMmhg: Int,
    val heartRateBpm: Int? = null,
) : IngestionRecordDto()

@Serializable
@SerialName("cardiovascular")
data class CardiovascularDto(
    override val providerRecordId: String? = null,
    @JsonSchema.Format("date-time")
    val measuredAt: String,
    val metricType: String,
    val value: Double,
    val unit: String,
) : IngestionRecordDto()

@Serializable
@SerialName("extended_body_measurement")
data class ExtendedBodyMeasurementDto(
    override val providerRecordId: String? = null,
    @JsonSchema.Format("date-time")
    val measuredAt: String,
    val metricType: String,
    val value: Double,
    val unit: String,
    val segment: String? = null,
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
    val activitySummaries: Int,
    val sleepSummaries: Int,
    val respiratoryRateSamples: Int,
    val hrvSamples: Int,
    val bloodPressureMeasurements: Int,
    val cardiovascularMeasurements: Int,
    val extendedBodyMeasurements: Int,
)

@Serializable
data class MetricSkippedCountsResponse(
    val duplicates: Int,
)

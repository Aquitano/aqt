package me.aquitano.health.api.dto

import io.ktor.openapi.*
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNames
import kotlinx.serialization.json.JsonElement
import me.aquitano.health.domain.BatchStatus

@Serializable
data class IngestionBatchRequest(
    val provider: String? = null,
    val providerInstanceId: String? = null,
    val batchExternalId: String? = null,
    @JsonSchema.Format("date-time")
    val ingestedAt: String? = null,
    val sourcePayload: JsonElement? = null,
    val records: List<IngestionRecord>? = null,
)

@Serializable
sealed class IngestionRecord {
    abstract val providerRecordId: String?
}

@Serializable
@SerialName("step_interval")
data class StepInterval(
    override val providerRecordId: String? = null,
    @JsonSchema.Format("date-time")
    val startAt: String,
    @JsonSchema.Format("date-time")
    val endAt: String,
    val steps: Int,
) : IngestionRecord()

@Serializable
@SerialName("sleep_session")
data class SleepSession(
    override val providerRecordId: String? = null,
    @JsonSchema.Format("date-time")
    val startAt: String,
    @JsonSchema.Format("date-time")
    val endAt: String,
    val stages: List<SleepStage> = emptyList(),
) : IngestionRecord()

@Serializable
data class SleepStage(
    val stage: String,
    @JsonSchema.Format("date-time")
    val startAt: String,
    @JsonSchema.Format("date-time")
    val endAt: String,
)

@Serializable
@SerialName("body_measurement")
data class BodyMeasurement(
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
) : IngestionRecord()

@Serializable
@SerialName("heart_rate")
data class HeartRate(
    override val providerRecordId: String? = null,
    @JsonSchema.Format("date-time")
    val measuredAt: String,
    val bpm: Int,
    val context: String? = null,
) : IngestionRecord()

@Serializable
@SerialName("activity_summary")
data class ActivitySummary(
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
) : IngestionRecord()

@Serializable
@SerialName("sleep_summary")
data class SleepSummary(
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
) : IngestionRecord()

@Serializable
@SerialName("respiratory_rate")
data class RespiratoryRate(
    override val providerRecordId: String? = null,
    @JsonSchema.Format("date-time")
    val measuredAt: String,
    val breathsPerMinute: Int,
    val context: String? = null,
) : IngestionRecord()

@Serializable
@SerialName("hrv")
data class Hrv(
    override val providerRecordId: String? = null,
    @JsonSchema.Format("date-time")
    val measuredAt: String,
    val metricType: String,
    val value: Double,
    val unit: String,
    val context: String? = null,
) : IngestionRecord()

@Serializable
@SerialName("blood_pressure")
data class BloodPressure(
    override val providerRecordId: String? = null,
    @JsonSchema.Format("date-time")
    val measuredAt: String,
    val systolicMmhg: Int,
    val diastolicMmhg: Int,
    val heartRateBpm: Int? = null,
) : IngestionRecord()

@Serializable
@SerialName("cardiovascular")
data class Cardiovascular(
    override val providerRecordId: String? = null,
    @JsonSchema.Format("date-time")
    val measuredAt: String,
    val metricType: String,
    val value: Double,
    val unit: String,
) : IngestionRecord()

@Serializable
@SerialName("extended_body_measurement")
data class ExtendedBodyMeasurement(
    override val providerRecordId: String? = null,
    @JsonSchema.Format("date-time")
    val measuredAt: String,
    val metricType: String,
    val value: Double,
    val unit: String,
    val segment: String? = null,
) : IngestionRecord()

@Serializable
@SerialName("scalar")
data class ScalarSample(
    override val providerRecordId: String? = null,
    @JsonSchema.Format("date-time")
    val measuredAt: String,
    val metricType: String,
    val value: Double,
    val unit: String,
    val context: String? = null,
    val segment: String? = null,
) : IngestionRecord()

@Serializable
data class IngestionSummaryResponse(
    val batchId: Int,
    val status: BatchStatus,
    val duplicateBatch: Boolean,
    val recordsReceived: Int,
    val ingestionRecordsStored: Int,
    /** Created-row counts keyed by structural table kind or scalar metric_type. */
    val metricsCreated: Map<String, Int>,
    val metricsSkipped: MetricSkippedCountsResponse,
    @JsonSchema.ItemsRef(String::class)
    val affectedStepSummaryDates: List<String>,
)

@Serializable
data class MetricSkippedCountsResponse(
    val duplicates: Int,
)

package me.aquitano.health.api.dto

import io.ktor.openapi.*
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class SourceMetadataResponse(
    val provider: String,
    val providerInstanceId: String,
)

@Serializable
data class ReadResponseMeta(
    val count: Int,
    val limit: Int,
    val sort: String,
    val order: String,
    val nextCursor: String? = null,
)

@Serializable
data class StepSamplesResponse(
    val items: List<StepSampleResponse>,
    val meta: ReadResponseMeta,
)

@Serializable
data class StepSampleResponse(
    val id: Int,
    @JsonSchema.Format("date-time")
    val startAt: String,
    @JsonSchema.Format("date-time")
    val endAt: String,
    val steps: Int,
    val source: SourceMetadataResponse? = null,
)

@Serializable
data class StepDailySummariesResponse(
    val items: List<StepDailySummaryResponse>,
    val meta: ReadResponseMeta,
)

@Serializable
data class StepDailySummaryResponse(
    @JsonSchema.Format("date")
    val date: String,
    val steps: Int,
    val sampleCount: Int,
    val source: SourceMetadataResponse? = null,
)

@Serializable
data class SleepSessionsResponse(
    val items: List<SleepSessionResponse>,
    val meta: ReadResponseMeta,
)

@Serializable
data class SleepNightsResponse(
    val items: List<SleepNightResponse>,
    val meta: ReadResponseMeta,
)

@Serializable
data class SleepNightResponse(
    @JsonSchema.Format("date")
    val date: String,
    val timezone: String,
    val session: SleepSessionResponse,
)

@Serializable
data class SleepSessionResponse(
    val id: Int,
    @JsonSchema.Format("date-time")
    val startAt: String,
    @JsonSchema.Format("date-time")
    val endAt: String,
    val durationSeconds: Long,
    val stages: List<SleepStageResponse>,
    val source: SourceMetadataResponse? = null,
)

@Serializable
data class SleepStageResponse(
    val stage: String,
    @JsonSchema.Format("date-time")
    val startAt: String,
    @JsonSchema.Format("date-time")
    val endAt: String,
    val durationSeconds: Long,
)

@Serializable
data class ActivitySummariesResponse(
    val items: List<ActivitySummaryResponse>,
    val meta: ReadResponseMeta,
)

@Serializable
data class ActivitySummaryResponse(
    val id: Int,
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
    val source: SourceMetadataResponse? = null,
)

@Serializable
data class SleepSummariesResponse(
    val items: List<SleepSummaryResponse>,
    val meta: ReadResponseMeta,
)

@Serializable
data class SleepSummaryResponse(
    val id: Int,
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
    val source: SourceMetadataResponse? = null,
)

@Serializable
data class ScalarSamplesResponse(
    val items: List<ScalarSampleResponse>,
    val meta: ReadResponseMeta,
)

@Serializable
data class ScalarSampleResponse(
    val id: Long,
    @JsonSchema.Format("date-time")
    val measuredAt: String,
    val metricType: String,
    val value: Double,
    val unit: String,
    val context: String? = null,
    val segment: String? = null,
    val source: SourceMetadataResponse? = null,
)

@Serializable
data class ScalarSummaryResponse(
    val metricType: String,
    val count: Int,
    val minValue: Double? = null,
    val maxValue: Double? = null,
    val avgValue: Double? = null,
    val latest: ScalarSampleResponse? = null,
)

@Serializable
data class MetricCatalogEntryResponse(
    val metricType: String,
    val family: String,
    val unit: String,
    val supportsSegment: Boolean,
    val contexts: List<String>? = null,
)

@Serializable
data class MetricTypeCatalogResponse(
    val items: List<MetricCatalogEntryResponse>,
)

@Serializable
data class BloodPressureMeasurementsResponse(
    val items: List<BloodPressureMeasurementResponse>,
    val meta: ReadResponseMeta,
)

@Serializable
data class BloodPressureMeasurementResponse(
    val id: Int,
    @JsonSchema.Format("date-time")
    val measuredAt: String,
    val systolicMmhg: Int,
    val diastolicMmhg: Int,
    val heartRateBpm: Int? = null,
    val source: SourceMetadataResponse? = null,
)

@Serializable
data class DashboardSummaryResponse(
    @JsonSchema.Format("date")
    val fromDate: String,
    @JsonSchema.Format("date")
    val toDate: String,
    val steps: DashboardStepsSummaryResponse,
    val latestWeight: ScalarSampleResponse?,
    val latestHeartRate: ScalarSampleResponse?,
    val lastSleepSession: SleepSessionResponse?,
)

@Serializable
data class DashboardStepsSummaryResponse(
    val steps: Int,
    val sampleCount: Int,
    val source: SourceMetadataResponse? = null,
)

@Serializable
data class HealthDayResponse(
    @JsonSchema.Format("date")
    val date: String,
    val timezone: String,
    @JsonSchema.Format("date-time")
    val from: String,
    @JsonSchema.Format("date-time")
    val to: String,
    val modules: List<HealthDayModuleName>,
    val steps: HealthDayStepsResponse? = null,
    val heartRate: HealthDayHeartRateResponse? = null,
    val weight: HealthDayWeightResponse? = null,
    val sleep: HealthDaySleepResponse? = null,
)

@Serializable
enum class HealthDayModuleName(val wireName: String) {
    @SerialName("steps")
    Steps("steps"),

    @SerialName("heartRate")
    HeartRate("heartRate"),

    @SerialName("weight")
    Weight("weight"),

    @SerialName("sleep")
    Sleep("sleep");

    companion object {
        fun fromWireName(value: String): HealthDayModuleName? =
            entries.firstOrNull { it.wireName == value }
    }
}

@Serializable
data class HealthDayBucketResponse(
    @JsonSchema.Format("date-time")
    val startAt: String,
    @JsonSchema.Format("date-time")
    val endAt: String,
    val value: Double? = null,
    val count: Int = 0,
)

@Serializable
data class HealthDayStepsResponse(
    val total: Int,
    val sampleCount: Int,
    val buckets: List<HealthDayBucketResponse>,
    val source: SourceMetadataResponse? = null,
)

@Serializable
data class HealthDayHeartRateResponse(
    val count: Int,
    val minBpm: Int? = null,
    val maxBpm: Int? = null,
    val avgBpm: Double? = null,
    val latest: ScalarSampleResponse? = null,
    val buckets: List<HealthDayBucketResponse>,
)

@Serializable
data class HealthDayWeightResponse(
    val latest: ScalarSampleResponse? = null,
    val previous: ScalarSampleResponse? = null,
    val delta: Double? = null,
    val points: List<ScalarSampleResponse>,
)

@Serializable
data class HealthDaySleepResponse(
    val totalDurationSeconds: Long,
    val sessions: List<SleepSessionResponse>,
    val stageTotals: List<HealthDaySleepStageTotalResponse>,
    val timeline: List<HealthDaySleepStageSegmentResponse>,
)

@Serializable
data class HealthDaySleepStageTotalResponse(
    val stage: String,
    val durationSeconds: Long,
)

@Serializable
data class HealthDaySleepStageSegmentResponse(
    val stage: String,
    @JsonSchema.Format("date-time")
    val startAt: String,
    @JsonSchema.Format("date-time")
    val endAt: String,
)

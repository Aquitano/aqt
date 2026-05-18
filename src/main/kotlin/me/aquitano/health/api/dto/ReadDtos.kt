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
data class BodyMeasurementsResponse(
    val items: List<BodyMeasurementResponse>,
    val meta: ReadResponseMeta,
)

@Serializable
data class BodyMeasurementResponse(
    val id: Int,
    @JsonSchema.Format("date-time")
    val measuredAt: String,
    val metricType: String,
    val value: Double,
    val unit: String,
    val source: SourceMetadataResponse? = null,
)

@Serializable
data class HeartRateSamplesResponse(
    val items: List<HeartRateSampleResponse>,
    val meta: ReadResponseMeta,
)

@Serializable
data class HeartRateSampleResponse(
    val id: Int,
    @JsonSchema.Format("date-time")
    val measuredAt: String,
    val bpm: Int,
    val context: String,
    val source: SourceMetadataResponse? = null,
)

@Serializable
data class HeartRateSummaryResponse(
    val count: Int,
    val minBpm: Int? = null,
    val maxBpm: Int? = null,
    val avgBpm: Double? = null,
    val latest: HeartRateSampleResponse? = null,
)

@Serializable
data class BodyMeasurementLatestResponse(
    val item: BodyMeasurementResponse? = null,
)

@Serializable
data class DashboardSummaryResponse(
    @JsonSchema.Format("date")
    val fromDate: String,
    @JsonSchema.Format("date")
    val toDate: String,
    val steps: DashboardStepsSummaryResponse,
    val latestWeight: BodyMeasurementResponse?,
    val latestHeartRate: HeartRateSampleResponse?,
    val lastSleepSession: SleepSessionResponse?,
)

@Serializable
data class DashboardStepsSummaryResponse(
    val steps: Int,
    val sampleCount: Int,
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
)

@Serializable
data class HealthDayHeartRateResponse(
    val count: Int,
    val minBpm: Int? = null,
    val maxBpm: Int? = null,
    val avgBpm: Double? = null,
    val latest: HeartRateSampleResponse? = null,
    val buckets: List<HealthDayBucketResponse>,
)

@Serializable
data class HealthDayWeightResponse(
    val latest: BodyMeasurementResponse? = null,
    val previous: BodyMeasurementResponse? = null,
    val delta: Double? = null,
    val points: List<BodyMeasurementResponse>,
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

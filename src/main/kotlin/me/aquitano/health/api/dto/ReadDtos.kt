package me.aquitano.health.api.dto

import io.ktor.openapi.*
import kotlinx.serialization.Serializable

@Serializable
data class SourceMetadataResponse(
    val provider: String,
    val providerInstanceId: String,
)

@Serializable
data class StepSamplesResponse(
    val items: List<StepSampleResponse>,
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
)

@Serializable
data class SleepNightsResponse(
    val items: List<SleepNightResponse>,
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

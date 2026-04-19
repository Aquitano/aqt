package me.aquitano.health.api.dto

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
    val startAt: String,
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
data class SleepSessionResponse(
    val id: Int,
    val startAt: String,
    val endAt: String,
    val durationSeconds: Long,
    val stages: List<SleepStageResponse>,
    val source: SourceMetadataResponse? = null,
)

@Serializable
data class SleepStageResponse(
    val stage: String,
    val startAt: String,
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
    val measuredAt: String,
    val bpm: Int,
    val context: String,
    val source: SourceMetadataResponse? = null,
)

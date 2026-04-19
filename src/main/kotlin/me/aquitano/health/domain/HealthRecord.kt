package me.aquitano.health.domain

import kotlinx.serialization.json.JsonObject
import java.time.Instant

sealed interface HealthRecord {
    val providerRecordId: String?
    val normalizedRecordJson: JsonObject
    val recordType: String
    val recordStartAt: Instant?
    val recordEndAt: Instant?
}

data class StepIntervalRecord(
    override val providerRecordId: String?,
    override val normalizedRecordJson: JsonObject,
    val startAt: Instant,
    val endAt: Instant,
    val steps: Int,
) : HealthRecord {
    override val recordType: String = RecordTypes.STEP_INTERVAL
    override val recordStartAt: Instant = startAt
    override val recordEndAt: Instant = endAt
}

data class SleepSessionRecord(
    override val providerRecordId: String?,
    override val normalizedRecordJson: JsonObject,
    val startAt: Instant,
    val endAt: Instant,
    val stages: List<SleepStageRecord>,
) : HealthRecord {
    override val recordType: String = RecordTypes.SLEEP_SESSION
    override val recordStartAt: Instant = startAt
    override val recordEndAt: Instant = endAt
}

data class SleepStageRecord(
    val stage: String,
    val startAt: Instant,
    val endAt: Instant,
)

data class BodyMeasurementRecord(
    override val providerRecordId: String?,
    override val normalizedRecordJson: JsonObject,
    val measuredAt: Instant,
    val measurements: List<BodyMeasurementValue>,
) : HealthRecord {
    override val recordType: String = RecordTypes.BODY_MEASUREMENT
    override val recordStartAt: Instant = measuredAt
    override val recordEndAt: Instant? = null
}

data class BodyMeasurementValue(
    val metricType: String,
    val value: Double,
    val unit: String,
)

data class HeartRateRecord(
    override val providerRecordId: String?,
    override val normalizedRecordJson: JsonObject,
    val measuredAt: Instant,
    val bpm: Int,
    val context: String,
) : HealthRecord {
    override val recordType: String = RecordTypes.HEART_RATE
    override val recordStartAt: Instant = measuredAt
    override val recordEndAt: Instant? = null
}

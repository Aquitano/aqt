package me.aquitano.health.domain

import kotlinx.serialization.json.JsonObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

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

data class ActivitySummaryRecord(
    override val providerRecordId: String?,
    override val normalizedRecordJson: JsonObject,
    val date: LocalDate,
    val distanceMeters: Double?,
    val activeEnergyKcal: Double?,
    val totalEnergyKcal: Double?,
    val elevationMeters: Double?,
    val softMinutes: Int?,
    val moderateMinutes: Int?,
    val intenseMinutes: Int?,
    val activeMinutes: Int?,
    val averageHeartRateBpm: Int?,
    val minHeartRateBpm: Int?,
    val maxHeartRateBpm: Int?,
) : HealthRecord {
    override val recordType: String = RecordTypes.ACTIVITY_SUMMARY

    // Day window in UTC so date-ranged replay can find activity summaries.
    override val recordStartAt: Instant = date.atStartOfDay(ZoneOffset.UTC).toInstant()
    override val recordEndAt: Instant = date.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant()
}

data class SleepSummaryRecord(
    override val providerRecordId: String?,
    override val normalizedRecordJson: JsonObject,
    val startAt: Instant,
    val endAt: Instant,
    val timeInBedSeconds: Long?,
    val totalSleepSeconds: Long?,
    val lightSleepSeconds: Long?,
    val deepSleepSeconds: Long?,
    val remSleepSeconds: Long?,
    val sleepEfficiencyPercent: Double?,
    val sleepLatencySeconds: Long?,
    val wakeupLatencySeconds: Long?,
    val wakeupDurationSeconds: Long?,
    val wakeupCount: Int?,
    val wasoSeconds: Long?,
    val sleepScore: Int?,
    val remEpisodesCount: Int?,
    val outOfBedCount: Int?,
    val awakeDurationSeconds: Long?,
    val overnightHrvRmssd: Double?,
    val respiratoryRhythm: Double?,
    val breathingQuality: Int?,
    val snoringDurationSeconds: Long?,
    val apneaHypopneaIndex: Double?,
    val movementScore: Double?,
    val snoringEpisodeCount: Int?,
    val hrAverageBpm: Int?,
    val hrMinBpm: Int?,
    val hrMaxBpm: Int?,
    val rrAverage: Double?,
    val rrMin: Double?,
    val rrMax: Double?,
) : HealthRecord {
    override val recordType: String = RecordTypes.SLEEP_SUMMARY
    override val recordStartAt: Instant = startAt
    override val recordEndAt: Instant = endAt
}

data class RespiratoryRateRecord(
    override val providerRecordId: String?,
    override val normalizedRecordJson: JsonObject,
    val measuredAt: Instant,
    val breathsPerMinute: Int,
    val context: String,
) : HealthRecord {
    override val recordType: String = RecordTypes.RESPIRATORY_RATE
    override val recordStartAt: Instant = measuredAt
    override val recordEndAt: Instant? = null
}

data class HrvRecord(
    override val providerRecordId: String?,
    override val normalizedRecordJson: JsonObject,
    val measuredAt: Instant,
    val metricType: String,
    val value: Double,
    val unit: String,
    val context: String,
) : HealthRecord {
    override val recordType: String = RecordTypes.HRV
    override val recordStartAt: Instant = measuredAt
    override val recordEndAt: Instant? = null
}

data class BloodPressureRecord(
    override val providerRecordId: String?,
    override val normalizedRecordJson: JsonObject,
    val measuredAt: Instant,
    val systolicMmhg: Int,
    val diastolicMmhg: Int,
    val heartRateBpm: Int?,
) : HealthRecord {
    override val recordType: String = RecordTypes.BLOOD_PRESSURE
    override val recordStartAt: Instant = measuredAt
    override val recordEndAt: Instant? = null
}

data class CardiovascularRecord(
    override val providerRecordId: String?,
    override val normalizedRecordJson: JsonObject,
    val measuredAt: Instant,
    val metricType: String,
    val value: Double,
    val unit: String,
) : HealthRecord {
    override val recordType: String = RecordTypes.CARDIOVASCULAR
    override val recordStartAt: Instant = measuredAt
    override val recordEndAt: Instant? = null
}

data class ExtendedBodyMeasurementRecord(
    override val providerRecordId: String?,
    override val normalizedRecordJson: JsonObject,
    val measuredAt: Instant,
    val measurements: List<ExtendedBodyMeasurementValue>,
) : HealthRecord {
    override val recordType: String = RecordTypes.EXTENDED_BODY_MEASUREMENT
    override val recordStartAt: Instant = measuredAt
    override val recordEndAt: Instant? = null
}

data class ExtendedBodyMeasurementValue(
    val metricType: String,
    val value: Double,
    val unit: String,
    val segment: String?,
)

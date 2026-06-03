package me.aquitano.health.application.metric.sleep.repository

data class SleepSessionRow(
    val id: Int,
    val sourceInstanceId: Int,
    val startAt: String,
    val endAt: String,
    val durationSeconds: Long
)

data class SleepNightRow(
    val date: String,
    val timezone: String,
    val session: SleepSessionRow,
)

data class SleepStageRow(
    val stage: String,
    val startAt: String,
    val endAt: String,
    val durationSeconds: Long
)

data class SleepSummaryRow(
    val id: Int,
    val sourceInstanceId: Int,
    val startAt: String,
    val endAt: String,
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
)


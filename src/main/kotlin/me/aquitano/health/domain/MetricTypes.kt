package me.aquitano.health.domain

object RecordTypes {
    const val STEP_INTERVAL = "step_interval"
    const val SLEEP_SESSION = "sleep_session"
    const val BODY_MEASUREMENT = "body_measurement"
    const val HEART_RATE = "heart_rate"
    const val ACTIVITY_SUMMARY = "activity_summary"
    const val SLEEP_SUMMARY = "sleep_summary"
    const val RESPIRATORY_RATE = "respiratory_rate"
    const val HRV = "hrv"
}

object SleepStages {
    val supported =
        setOf("awake", "restless", "asleep", "light", "deep", "rem", "unknown")
}

object BodyMetricTypes {
    const val WEIGHT = "weight"
    const val BODY_FAT = "body_fat"
    const val MUSCLE = "muscle"
    const val WATER = "water"
    const val VISCERAL_FAT = "visceral_fat"

    val supported = setOf(WEIGHT, BODY_FAT, MUSCLE, WATER, VISCERAL_FAT)
}

object HeartRateContexts {
    val supported =
        setOf("resting", "active", "workout", "sleep", "general", "unknown")
}

object RespiratoryRateContexts {
    val supported =
        setOf("sleep", "resting", "general", "unknown")
}

object HrvMetricTypes {
    const val RMSSD = "rmssd"

    val supported = setOf(RMSSD)
}

object HrvContexts {
    val supported =
        setOf("sleep", "resting", "general", "unknown")
}

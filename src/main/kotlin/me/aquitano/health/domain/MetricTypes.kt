package me.aquitano.health.domain

object RecordTypes {
    const val STEP_INTERVAL = "step_interval"
    const val SLEEP_SESSION = "sleep_session"
    const val BODY_MEASUREMENT = "body_measurement"
    const val HEART_RATE = "heart_rate"
}

object SleepStages {
    val supported = setOf("awake", "light", "deep", "rem", "unknown")
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
    val supported = setOf("resting", "workout", "sleep", "general", "unknown")
}

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
    const val BLOOD_PRESSURE = "blood_pressure"
    const val CARDIOVASCULAR = "cardiovascular"
    const val EXTENDED_BODY_MEASUREMENT = "extended_body_measurement"

    /** Generic scalar record carrying an explicit metric type from the scalar registry. */
    const val SCALAR = "scalar"
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
    const val FAT_MASS = "fat_mass"
    const val FAT_FREE_MASS = "fat_free_mass"
    const val BONE_MASS = "bone_mass"
    const val INTRACELLULAR_WATER = "intracellular_water"
    const val EXTRACELLULAR_WATER = "extracellular_water"
    const val BASAL_METABOLIC_RATE = "basal_metabolic_rate"
    const val SEGMENTAL_FAT_MASS = "segmental_fat_mass"
    const val SEGMENTAL_MUSCLE_MASS = "segmental_muscle_mass"
    const val SEGMENTAL_FAT_FREE_MASS = "segmental_fat_free_mass"

    val supported = setOf(
        WEIGHT, BODY_FAT, MUSCLE, WATER, VISCERAL_FAT,
        FAT_MASS, FAT_FREE_MASS, BONE_MASS,
        INTRACELLULAR_WATER, EXTRACELLULAR_WATER, BASAL_METABOLIC_RATE,
        SEGMENTAL_FAT_MASS, SEGMENTAL_MUSCLE_MASS, SEGMENTAL_FAT_FREE_MASS,
    )
}

object BodySegments {
    val supported =
        setOf("left_arm", "right_arm", "left_leg", "right_leg", "trunk")
}

object CardiovascularMetricTypes {
    const val PULSE_WAVE_VELOCITY = "pulse_wave_velocity"
    const val VASCULAR_AGE = "vascular_age"
    const val STANDING_HEART_RATE = "standing_heart_rate"

    val supported = setOf(PULSE_WAVE_VELOCITY, VASCULAR_AGE, STANDING_HEART_RATE)
}

object HeartRateContexts {
    val supported =
        setOf("resting", "active", "workout", "sleep", "general", "unknown", "standing")
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

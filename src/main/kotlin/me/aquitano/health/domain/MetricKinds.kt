package me.aquitano.health.domain

/**
 * metricsCreated map keys for the structural (non-scalar) metric tables. Scalar samples
 * are counted under their metric_type value directly; together they form the key space of
 * the wire-level metricsCreated map.
 */
object StructuralMetricKinds {
    const val STEP_SAMPLES = "step_samples"
    const val SLEEP_SESSIONS = "sleep_sessions"
    const val SLEEP_STAGES = "sleep_stages"
    const val SLEEP_SUMMARIES = "sleep_summaries"
    const val ACTIVITY_SUMMARIES = "activity_summaries"
    const val BLOOD_PRESSURE_MEASUREMENTS = "blood_pressure_measurements"
}

/**
 * One entry per derived projection that is rebuilt for affected dates after ingestion.
 * Every entry must have a registered DerivedRebuildModule; the registry enforces coverage.
 */
enum class DerivedKind {
    STEP_SUMMARY,
    SLEEP_NIGHT,
}

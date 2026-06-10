package me.aquitano.health.domain

/**
 * One entry per metric family whose created rows are counted in ingestion summaries.
 * Adding a metric family means adding an entry here plus a write arm in MetricWriteService;
 * counts, accumulators, and DTO mapping pick it up from the map shape.
 */
enum class MetricKind {
    STEP_SAMPLES,
    SLEEP_SESSIONS,
    SLEEP_STAGES,
    BODY_MEASUREMENTS,
    HEART_RATE_SAMPLES,
    ACTIVITY_SUMMARIES,
    SLEEP_SUMMARIES,
    RESPIRATORY_RATE_SAMPLES,
    HRV_SAMPLES,
    BLOOD_PRESSURE_MEASUREMENTS,
    CARDIOVASCULAR_MEASUREMENTS,
    EXTENDED_BODY_MEASUREMENTS,
}

/**
 * One entry per derived projection that is rebuilt for affected dates after ingestion.
 * Every entry must have a registered DerivedRebuildModule; the registry enforces coverage.
 */
enum class DerivedKind {
    STEP_SUMMARY,
    SLEEP_NIGHT,
    HEART_RATE_CANONICAL,
    RESPIRATORY_RATE_CANONICAL,
    HRV_CANONICAL,
    BODY_MEASUREMENT_CANONICAL,
    SLEEP_SUMMARY_CANONICAL,
    SLEEP_SESSION_CANONICAL,
    ACTIVITY_SUMMARY_CANONICAL,
}

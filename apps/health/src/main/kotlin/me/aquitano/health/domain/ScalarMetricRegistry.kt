package me.aquitano.health.domain

/** Rank family keys shared between provider_ranks, metric_catalog, and the canonical view. */
object MetricFamilies {
    const val STEPS = "steps"
    const val ACTIVITY = "activity"
    const val SLEEP = "sleep"
    const val SLEEP_SUMMARY = "sleep_summary"
    const val BODY_MEASUREMENT = "body_measurement"
    const val HEART_RATE = "heart_rate"
    const val RESPIRATORY_RATE = "respiratory_rate"
    const val HRV = "hrv"
    const val CARDIOVASCULAR = "cardiovascular"
}

object ScalarMetricTypes {
    const val HEART_RATE = "heart_rate"
    const val RESPIRATORY_RATE = "respiratory_rate"
    const val HRV_RMSSD = "hrv_rmssd"
}

data class ScalarValueRange(
    val min: Double,
    val max: Double?,
    val minInclusive: Boolean = true,
)

/**
 * One scalar metric the system can store in scalar_samples. Adding a new scalar metric is
 * one entry here: the metric_catalog row is upserted at startup, ingestion validation,
 * counting, and the read catalog all derive from the descriptor.
 */
data class ScalarMetricDescriptor(
    val metricType: String,
    val family: String,
    val unit: String,
    val valueRange: ScalarValueRange,
    val allowedContexts: Set<String>? = null,
    val supportsSegment: Boolean = false,
    /** The legacy per-family ingestion record type whose records write this metric. */
    val recordType: String,
) {
    fun valueIsValid(value: Double): Boolean {
        val aboveMin =
            if (valueRange.minInclusive) value >= valueRange.min else value > valueRange.min
        val belowMax = valueRange.max?.let { value <= it } ?: true
        return aboveMin && belowMax
    }
}

object ScalarMetricRegistry {
    val descriptors: List<ScalarMetricDescriptor> = buildList {
        add(
            ScalarMetricDescriptor(
                metricType = ScalarMetricTypes.HEART_RATE,
                family = MetricFamilies.HEART_RATE,
                unit = "bpm",
                valueRange = ScalarValueRange(25.0, 250.0),
                allowedContexts = HeartRateContexts.supported,
                recordType = RecordTypes.HEART_RATE,
            )
        )
        add(
            ScalarMetricDescriptor(
                metricType = ScalarMetricTypes.RESPIRATORY_RATE,
                family = MetricFamilies.RESPIRATORY_RATE,
                unit = "breaths_per_minute",
                valueRange = ScalarValueRange(5.0, 80.0),
                allowedContexts = RespiratoryRateContexts.supported,
                recordType = RecordTypes.RESPIRATORY_RATE,
            )
        )
        add(
            ScalarMetricDescriptor(
                metricType = ScalarMetricTypes.HRV_RMSSD,
                family = MetricFamilies.HRV,
                unit = "ms",
                valueRange = ScalarValueRange(0.0, 500.0, minInclusive = false),
                allowedContexts = HrvContexts.supported,
                recordType = RecordTypes.HRV,
            )
        )

        fun body(metricType: String, unit: String, range: ScalarValueRange) = add(
            ScalarMetricDescriptor(
                metricType = metricType,
                family = MetricFamilies.BODY_MEASUREMENT,
                unit = unit,
                valueRange = range,
                recordType = RecordTypes.BODY_MEASUREMENT,
            )
        )
        body(BodyMetricTypes.WEIGHT, "kg", ScalarValueRange(0.0, null, minInclusive = false))
        body(BodyMetricTypes.BODY_FAT, "percent", ScalarValueRange(0.0, 100.0))
        body(BodyMetricTypes.MUSCLE, "kg", ScalarValueRange(0.0, null, minInclusive = false))
        body(BodyMetricTypes.WATER, "percent", ScalarValueRange(0.0, 100.0))
        body(BodyMetricTypes.VISCERAL_FAT, "rating", ScalarValueRange(0.0, null, minInclusive = false))

        fun extendedBody(
            metricType: String,
            unit: String,
            range: ScalarValueRange,
            supportsSegment: Boolean = false,
        ) = add(
            ScalarMetricDescriptor(
                metricType = metricType,
                family = MetricFamilies.BODY_MEASUREMENT,
                unit = unit,
                valueRange = range,
                supportsSegment = supportsSegment,
                recordType = RecordTypes.EXTENDED_BODY_MEASUREMENT,
            )
        )
        extendedBody(BodyMetricTypes.FAT_MASS, "kg", ScalarValueRange(0.0, null, minInclusive = false))
        extendedBody(BodyMetricTypes.FAT_FREE_MASS, "kg", ScalarValueRange(0.0, null, minInclusive = false))
        extendedBody(BodyMetricTypes.BONE_MASS, "kg", ScalarValueRange(0.0, null, minInclusive = false))
        extendedBody(BodyMetricTypes.INTRACELLULAR_WATER, "kg", ScalarValueRange(0.0, null))
        extendedBody(BodyMetricTypes.EXTRACELLULAR_WATER, "kg", ScalarValueRange(0.0, null))
        extendedBody(BodyMetricTypes.BASAL_METABOLIC_RATE, "kcal", ScalarValueRange(0.0, null, minInclusive = false))
        extendedBody(
            BodyMetricTypes.SEGMENTAL_FAT_MASS,
            "kg",
            ScalarValueRange(0.0, null, minInclusive = false),
            supportsSegment = true,
        )
        extendedBody(
            BodyMetricTypes.SEGMENTAL_MUSCLE_MASS,
            "kg",
            ScalarValueRange(0.0, null, minInclusive = false),
            supportsSegment = true,
        )
        extendedBody(
            BodyMetricTypes.SEGMENTAL_FAT_FREE_MASS,
            "kg",
            ScalarValueRange(0.0, null, minInclusive = false),
            supportsSegment = true,
        )

        fun cardiovascular(metricType: String, unit: String) = add(
            ScalarMetricDescriptor(
                metricType = metricType,
                family = MetricFamilies.CARDIOVASCULAR,
                unit = unit,
                valueRange = ScalarValueRange(0.0, null, minInclusive = false),
                recordType = RecordTypes.CARDIOVASCULAR,
            )
        )
        cardiovascular(CardiovascularMetricTypes.PULSE_WAVE_VELOCITY, "m/s")
        cardiovascular(CardiovascularMetricTypes.VASCULAR_AGE, "years")
        cardiovascular(CardiovascularMetricTypes.STANDING_HEART_RATE, "bpm")
    }

    private val byType: Map<String, ScalarMetricDescriptor> =
        descriptors.associateBy { it.metricType }

    init {
        require(byType.size == descriptors.size) {
            "Duplicate scalar metric types in ScalarMetricRegistry"
        }
    }

    fun find(metricType: String): ScalarMetricDescriptor? = byType[metricType]

    fun get(metricType: String): ScalarMetricDescriptor =
        requireNotNull(byType[metricType]) { "Unknown scalar metric type '$metricType'" }

    val metricTypes: Set<String> = byType.keys

    val bodyMetricTypes: Set<String> =
        descriptors
            .filter { it.recordType == RecordTypes.BODY_MEASUREMENT }
            .map { it.metricType }
            .toSet()

    val extendedBodyMetricTypes: Set<String> =
        descriptors
            .filter { it.recordType == RecordTypes.EXTENDED_BODY_MEASUREMENT }
            .map { it.metricType }
            .toSet()

    val cardiovascularMetricTypes: Set<String> =
        descriptors
            .filter { it.recordType == RecordTypes.CARDIOVASCULAR }
            .map { it.metricType }
            .toSet()

    /** scalar_samples metric types written by records of the given ingestion record type. */
    fun metricTypesForRecordType(recordType: String): Set<String> =
        when (recordType) {
            RecordTypes.HEART_RATE -> setOf(ScalarMetricTypes.HEART_RATE)
            RecordTypes.RESPIRATORY_RATE -> setOf(ScalarMetricTypes.RESPIRATORY_RATE)
            RecordTypes.HRV -> setOf(ScalarMetricTypes.HRV_RMSSD)
            RecordTypes.BODY_MEASUREMENT -> bodyMetricTypes
            RecordTypes.EXTENDED_BODY_MEASUREMENT -> extendedBodyMetricTypes
            RecordTypes.CARDIOVASCULAR -> cardiovascularMetricTypes
            RecordTypes.SCALAR -> metricTypes
            else -> emptySet()
        }
}

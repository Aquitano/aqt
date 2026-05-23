package me.aquitano.health.application

import me.aquitano.health.infrastructure.repositories.*
import java.time.Duration
import java.time.Instant
import kotlin.math.abs

class CanonicalMetricsService(
    private val policy: CanonicalMetricsPolicy,
) {
    fun canonicalStepDailySummaries(
        rows: List<StepDailySummaryRow>,
        metadata: Map<Int, SourceMetadata>,
    ): List<StepDailySummaryRow> =
        rows.groupBy { it.date }
            .values
            .map { candidates ->
                candidates.maxWithOrNull(
                    compareBy<StepDailySummaryRow> { -rank(CanonicalMetricFamily.STEPS, it, metadata) }
                        .thenBy { it.sampleCount }
                        .thenBy { it.steps }
                        .thenBy { it.sourceInstanceId }
                )!!
            }
            .sortedWith(compareBy<StepDailySummaryRow> { it.date }.thenBy { it.sourceInstanceId })

    fun canonicalStepSamples(
        rows: List<StepSampleRow>,
        metadata: Map<Int, SourceMetadata>,
    ): List<StepSampleRow> =
        canonicalIntervals(
            rows = rows.sortedWith(compareBy<StepSampleRow> { instant(it.startAt) }.thenBy { instant(it.endAt) }.thenBy { it.id }),
            overlaps = { left, right ->
                left.sourceInstanceId != right.sourceInstanceId &&
                instant(left.startAt).isBefore(instant(right.endAt)) &&
                    instant(right.startAt).isBefore(instant(left.endAt))
            },
            choosePreferred = { left, right ->
                listOf(left, right).minWithOrNull(
                    compareBy<StepSampleRow> { rank(CanonicalMetricFamily.STEPS, it, metadata) }
                        .thenBy { durationSeconds(it.startAt, it.endAt) }
                        .thenByDescending { stepsPerSecond(it) }
                        .thenBy { it.id }
                )!!
            },
            start = { instant(it.startAt) },
        )

    fun canonicalActivitySummaries(
        rows: List<ActivitySummaryRow>,
        metadata: Map<Int, SourceMetadata>,
    ): List<ActivitySummaryRow> =
        rows.groupBy { it.date }
            .values
            .map { candidates ->
                candidates.minWithOrNull(
                    compareBy<ActivitySummaryRow> { rank(CanonicalMetricFamily.ACTIVITY, it, metadata) }
                        .thenByDescending { activityFieldCount(it) }
                        .thenBy { it.id }
                )!!
            }
            .sortedWith(compareBy<ActivitySummaryRow> { it.date }.thenBy { it.id })

    fun canonicalSleepSessions(
        rows: List<SleepSessionRow>,
        stagesBySession: Map<Int, List<SleepStageRow>>,
        metadata: Map<Int, SourceMetadata>,
    ): List<SleepSessionRow> =
        canonicalIntervals(
            rows = rows.sortedWith(compareBy<SleepSessionRow> { instant(it.startAt) }.thenBy { instant(it.endAt) }.thenBy { it.id }),
            overlaps = { left, right ->
                left.sourceInstanceId != right.sourceInstanceId && sleepOverlaps(left, right)
            },
            choosePreferred = { left, right ->
                listOf(left, right).maxWithOrNull(
                    compareBy<SleepSessionRow> { stagesBySession[it.id].orEmpty().size }
                        .thenBy { stagesBySession[it.id].orEmpty().map { stage -> stage.stage }.filterNot { stage -> stage == "unknown" }.toSet().size }
                        .thenBy { durationSeconds(it.startAt, it.endAt) == it.durationSeconds }
                        .thenBy { -rank(CanonicalMetricFamily.SLEEP, it, metadata) }
                        .thenBy { -it.id }
                )!!
            },
            start = { instant(it.startAt) },
        )

    fun canonicalSleepSummaries(
        rows: List<SleepSummaryRow>,
        metadata: Map<Int, SourceMetadata>,
    ): List<SleepSummaryRow> =
        canonicalIntervals(
            rows = rows.sortedWith(compareBy<SleepSummaryRow> { instant(it.startAt) }.thenBy { instant(it.endAt) }.thenBy { it.id }),
            overlaps = { left, right ->
                left.sourceInstanceId != right.sourceInstanceId && sleepOverlaps(left, right)
            },
            choosePreferred = { left, right ->
                listOf(left, right).minWithOrNull(
                    compareByDescending<SleepSummaryRow> { sleepSummaryFieldCount(it) }
                        .thenBy { rank(CanonicalMetricFamily.SLEEP_SUMMARY, it, metadata) }
                        .thenBy { it.id }
                )!!
            },
            start = { instant(it.startAt) },
        )

    fun canonicalBodyMeasurements(
        rows: List<BodyMeasurementRow>,
        metadata: Map<Int, SourceMetadata>,
    ): List<BodyMeasurementRow> =
        rows.groupBy { it.metricType to it.measuredAt }
            .values
            .flatMap { candidates ->
                if (candidates.map { it.sourceInstanceId }.toSet().size <= 1) {
                    candidates
                } else {
                    listOf(
                        candidates.minWithOrNull(
                            compareBy<BodyMeasurementRow> { rank(CanonicalMetricFamily.BODY_MEASUREMENT, it, metadata) }
                                .thenBy { it.id }
                        )!!
                    )
                }
            }
            .sortedWith(compareBy<BodyMeasurementRow> { instant(it.measuredAt) }.thenBy { it.metricType }.thenBy { it.id })

    fun canonicalHeartRateSamples(
        rows: List<HeartRateSampleRow>,
        metadata: Map<Int, SourceMetadata>,
    ): List<HeartRateSampleRow> {
        val densityBySource = rows.groupingBy { it.sourceInstanceId }.eachCount()
        return timestampBuckets(
            rows = rows.sortedWith(compareBy<HeartRateSampleRow> { instant(it.measuredAt) }.thenBy { it.id }),
            measuredAt = { it.measuredAt },
            groupKey = { it.context },
        ).flatMap { candidates ->
            if (candidates.map { it.sourceInstanceId }.toSet().size <= 1) {
                candidates
            } else {
                listOf(
                    candidates.maxWithOrNull(
                        compareBy<HeartRateSampleRow> { densityBySource[it.sourceInstanceId] ?: 0 }
                            .thenBy { -policy.heartRateRank(metadata[it.sourceInstanceId]?.provider, it.context) }
                            .thenBy { -it.id }
                    )!!
                )
            }
        }.sortedWith(compareBy<HeartRateSampleRow> { instant(it.measuredAt) }.thenBy { it.id })
    }

    fun canonicalRespiratoryRateSamples(
        rows: List<RespiratoryRateSampleRow>,
        metadata: Map<Int, SourceMetadata>,
    ): List<RespiratoryRateSampleRow> =
        timestampBuckets(
            rows = rows.sortedWith(compareBy<RespiratoryRateSampleRow> { instant(it.measuredAt) }.thenBy { it.id }),
            measuredAt = { it.measuredAt },
            groupKey = { it.context },
        ).flatMap { candidates ->
            if (candidates.map { it.sourceInstanceId }.toSet().size <= 1) {
                candidates
            } else {
                listOf(
                    candidates.minWithOrNull(
                        compareBy<RespiratoryRateSampleRow> { rank(CanonicalMetricFamily.RESPIRATORY_RATE, it, metadata) }
                            .thenBy { it.id }
                    )!!
                )
            }
        }.sortedWith(compareBy<RespiratoryRateSampleRow> { instant(it.measuredAt) }.thenBy { it.id })

    fun canonicalHrvSamples(
        rows: List<HrvSampleRow>,
        metadata: Map<Int, SourceMetadata>,
    ): List<HrvSampleRow> =
        timestampBuckets(
            rows = rows.sortedWith(compareBy<HrvSampleRow> { instant(it.measuredAt) }.thenBy { it.id }),
            measuredAt = { it.measuredAt },
            groupKey = { it.metricType to it.context },
        ).flatMap { candidates ->
            if (candidates.map { it.sourceInstanceId }.toSet().size <= 1) {
                candidates
            } else {
                listOf(
                    candidates.minWithOrNull(
                        compareBy<HrvSampleRow> { rank(CanonicalMetricFamily.HRV, it, metadata) }
                            .thenBy { it.id }
                    )!!
                )
            }
        }.sortedWith(compareBy<HrvSampleRow> { instant(it.measuredAt) }.thenBy { it.id })

    private fun <T> canonicalIntervals(
        rows: List<T>,
        overlaps: (T, T) -> Boolean,
        choosePreferred: (T, T) -> T,
        start: (T) -> Instant,
    ): List<T> {
        val selected = mutableListOf<T>()
        rows.forEach { row ->
            val overlapping = selected.filter { overlaps(it, row) }
            if (overlapping.isEmpty()) {
                selected += row
            } else {
                val candidateWinsAll = overlapping.all { existing ->
                    choosePreferred(existing, row) == row
                }
                if (candidateWinsAll) {
                    selected.removeAll(overlapping.toSet())
                    selected += row
                }
            }
        }
        return selected.sortedBy(start)
    }

    private fun <T, K> timestampBuckets(
        rows: List<T>,
        measuredAt: (T) -> String,
        groupKey: (T) -> K,
    ): List<List<T>> {
        val buckets = mutableListOf<MutableList<T>>()
        rows.forEach { row ->
            val rowAt = instant(measuredAt(row))
            val bucket = buckets.firstOrNull { existing ->
                groupKey(existing.first()) == groupKey(row) &&
                    abs(Duration.between(instant(measuredAt(existing.first())), rowAt).seconds) <= SameTimestampToleranceSeconds
            }
            if (bucket == null) {
                buckets += mutableListOf(row)
            } else {
                bucket += row
            }
        }
        return buckets
    }

    private fun sleepOverlaps(left: SleepSessionRow, right: SleepSessionRow): Boolean =
        sleepOverlaps(left.startAt, left.endAt, right.startAt, right.endAt)

    private fun sleepOverlaps(left: SleepSummaryRow, right: SleepSummaryRow): Boolean =
        sleepOverlaps(left.startAt, left.endAt, right.startAt, right.endAt)

    private fun sleepOverlaps(
        leftStart: String,
        leftEnd: String,
        rightStart: String,
        rightEnd: String,
    ): Boolean {
        val overlap = overlapSeconds(
            instant(leftStart),
            instant(leftEnd),
            instant(rightStart),
            instant(rightEnd),
        )
        if (overlap <= 0) return false
        val shorter = minOf(
            durationSeconds(leftStart, leftEnd),
            durationSeconds(rightStart, rightEnd),
        )
        return overlap >= SleepOverlapMinimumSeconds || overlap.toDouble() / shorter.toDouble() >= 0.5
    }

    private fun rank(
        family: CanonicalMetricFamily,
        row: Any,
        metadata: Map<Int, SourceMetadata>,
    ): Int {
        val sourceInstanceId = when (row) {
            is StepDailySummaryRow -> row.sourceInstanceId
            is StepSampleRow -> row.sourceInstanceId
            is ActivitySummaryRow -> row.sourceInstanceId
            is SleepSessionRow -> row.sourceInstanceId
            is SleepSummaryRow -> row.sourceInstanceId
            is BodyMeasurementRow -> row.sourceInstanceId
            is RespiratoryRateSampleRow -> row.sourceInstanceId
            is HrvSampleRow -> row.sourceInstanceId
            else -> return Int.MAX_VALUE
        }
        return policy.rank(family, metadata[sourceInstanceId]?.provider)
    }

    private fun stepsPerSecond(row: StepSampleRow): Double =
        row.steps.toDouble() / durationSeconds(row.startAt, row.endAt).coerceAtLeast(1).toDouble()

    private fun activityFieldCount(row: ActivitySummaryRow): Int =
        listOf(
            row.distanceMeters,
            row.activeEnergyKcal,
            row.totalEnergyKcal,
            row.elevationMeters,
            row.softMinutes,
            row.moderateMinutes,
            row.intenseMinutes,
            row.activeMinutes,
            row.averageHeartRateBpm,
            row.minHeartRateBpm,
            row.maxHeartRateBpm,
        ).count { it != null }

    private fun sleepSummaryFieldCount(row: SleepSummaryRow): Int =
        listOf(
            row.timeInBedSeconds,
            row.totalSleepSeconds,
            row.lightSleepSeconds,
            row.deepSleepSeconds,
            row.remSleepSeconds,
            row.sleepEfficiencyPercent,
            row.sleepLatencySeconds,
            row.wakeupLatencySeconds,
            row.wakeupDurationSeconds,
            row.wakeupCount,
            row.wasoSeconds,
            row.sleepScore,
        ).count { it != null }

    private fun instant(value: String): Instant = Instant.parse(value)

    private fun durationSeconds(startAt: String, endAt: String): Long =
        Duration.between(instant(startAt), instant(endAt)).seconds

    private fun overlapSeconds(
        leftStart: Instant,
        leftEnd: Instant,
        rightStart: Instant,
        rightEnd: Instant,
    ): Long {
        val start = maxOf(leftStart, rightStart)
        val end = minOf(leftEnd, rightEnd)
        return if (start.isBefore(end)) Duration.between(start, end).seconds else 0
    }

    private companion object {
        const val SameTimestampToleranceSeconds = 30L
        const val SleepOverlapMinimumSeconds = 30L * 60L
    }
}

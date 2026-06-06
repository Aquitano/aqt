package me.aquitano.health.application.metric.sleep.derived

import me.aquitano.health.application.CanonicalMetricsPolicy
import me.aquitano.health.application.metric.common.CanonicalIntervalCandidate
import me.aquitano.health.application.metric.common.canonicalIntervalRows
import me.aquitano.health.application.metric.sleep.repository.CanonicalSleepSummaryDerivationRepository
import me.aquitano.health.application.metric.sleep.repository.CanonicalSleepSummaryOutput
import me.aquitano.health.application.metric.sleep.repository.CanonicalSleepSummaryRowOutput
import me.aquitano.health.application.metric.sleep.repository.SleepSummaryRow
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

const val CANONICAL_SLEEP_SUMMARY_ALGORITHM_VERSION = 1

class CanonicalSleepSummaryDerivationService(
    private val repository: CanonicalSleepSummaryDerivationRepository,
    private val policy: CanonicalMetricsPolicy = CanonicalMetricsPolicy.default(),
) {
    suspend fun recompute(dates: Set<LocalDate>, computedAt: Instant) {
        dates.forEach { date ->
            val dayStart = date.atStartOfDay().toInstant(ZoneOffset.UTC)
            val dayEnd = date.plusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC)
            val rawSummaries = repository.listRawSummariesForDay(dayStart, dayEnd)
            val metadata = repository.sourceMetadataFor(rawSummaries.map { it.sourceInstanceId }.toSet())
            val preparedSummaries = rawSummaries.map { preparedCanonicalSummary(it, metadata) }
                .sortedWith(compareBy<PreparedCanonicalSleepSummary> { it.candidate.startAt }
                    .thenBy { it.candidate.endAt }
                    .thenBy { it.candidate.row.id })
            
            val canonical = canonicalIntervalRows(
                rows = preparedSummaries.map { it.candidate },
                overlaps = { left, right ->
                    val leftPrepared = preparedSummaries.first { it.candidate === left }
                    val rightPrepared = preparedSummaries.first { it.candidate === right }
                    sleepOverlaps(leftPrepared, rightPrepared)
                },
                choosePreferred = { left, right ->
                    val leftPrepared = preparedSummaries.first { it.candidate === left }
                    val rightPrepared = preparedSummaries.first { it.candidate === right }
                    listOf(leftPrepared, rightPrepared).minWithOrNull(
                        compareByDescending<PreparedCanonicalSleepSummary> { it.fieldCount }
                            .thenBy { it.providerRank }
                            .thenBy { it.candidate.row.id }
                    )!!.candidate
                }
            )
            val selectedPreparedSummaries = preparedSummaries.filter { canonical.contains(it.candidate.row) }

            repository.persistCanonicalOutput(
                CanonicalSleepSummaryOutput(
                    date = date,
                    algorithmVersion = CANONICAL_SLEEP_SUMMARY_ALGORITHM_VERSION,
                    computedAt = computedAt,
                    summaries = selectedPreparedSummaries.map(::toOutput),
                )
            )
        }
    }

    private fun toOutput(summary: PreparedCanonicalSleepSummary): CanonicalSleepSummaryRowOutput =
        CanonicalSleepSummaryRowOutput(
            sleepSummaryId = summary.candidate.row.id,
            sourceInstanceId = summary.candidate.row.sourceInstanceId,
            startAt = summary.candidate.startAt,
            endAt = summary.candidate.endAt,
        )

    private fun preparedCanonicalSummary(
        row: SleepSummaryRow,
        metadata: Map<Int, me.aquitano.health.application.metric.common.repository.SourceMetadata>
    ): PreparedCanonicalSleepSummary {
        val startAt = Instant.parse(row.startAt)
        val endAt = Instant.parse(row.endAt)
        return PreparedCanonicalSleepSummary(
            candidate = CanonicalIntervalCandidate(
                row = row,
                sourceInstanceId = row.sourceInstanceId,
                startAt = startAt,
                endAt = endAt,
            ),
            durationSeconds = Duration.between(startAt, endAt).seconds,
            providerRank = policy.rank(me.aquitano.health.application.CanonicalMetricFamily.SLEEP_SUMMARY, metadata[row.sourceInstanceId]?.provider),
            fieldCount = sleepSummaryFieldCount(row),
        )
    }

    private fun sleepOverlaps(left: PreparedCanonicalSleepSummary, right: PreparedCanonicalSleepSummary): Boolean {
        val overlap = overlapSeconds(
            left.candidate.startAt,
            left.candidate.endAt,
            right.candidate.startAt,
            right.candidate.endAt,
        )
        if (overlap <= 0) return false
        val shorter = minOf(left.durationSeconds, right.durationSeconds)
        return overlap >= SleepOverlapMinimumSeconds || overlap.toDouble() / shorter.toDouble() >= 0.5
    }

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

    private companion object {
        const val SleepOverlapMinimumSeconds = 30L * 60L
    }
}

private data class PreparedCanonicalSleepSummary(
    val candidate: CanonicalIntervalCandidate<SleepSummaryRow>,
    val durationSeconds: Long,
    val providerRank: Int,
    val fieldCount: Int,
)

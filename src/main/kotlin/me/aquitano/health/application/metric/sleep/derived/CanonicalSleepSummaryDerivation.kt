package me.aquitano.health.application.metric.sleep.derived

import me.aquitano.health.application.CanonicalMetricsPolicy
import me.aquitano.health.application.CanonicalMetricsService
import me.aquitano.health.application.metric.sleep.repository.CanonicalSleepSummaryDerivationRepository
import me.aquitano.health.application.metric.sleep.repository.CanonicalSleepSummaryOutput
import me.aquitano.health.application.metric.sleep.repository.CanonicalSleepSummaryRowOutput
import me.aquitano.health.application.metric.sleep.repository.SleepSummaryRow
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

const val CANONICAL_SLEEP_SUMMARY_ALGORITHM_VERSION = 1

class CanonicalSleepSummaryDerivationService(
    private val repository: CanonicalSleepSummaryDerivationRepository,
    private val canonicalMetricsService: CanonicalMetricsService =
        CanonicalMetricsService(CanonicalMetricsPolicy.default()),
) {
    suspend fun recompute(dates: Set<LocalDate>, computedAt: Instant) {
        dates.forEach { date ->
            val dayStart = date.atStartOfDay().toInstant(ZoneOffset.UTC)
            val dayEnd = date.plusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC)
            val rawSummaries = repository.listRawSummariesForDay(dayStart, dayEnd)
            val metadata = repository.sourceMetadataFor(rawSummaries.map { it.sourceInstanceId }.toSet())
            val canonical = canonicalMetricsService.canonicalSleepSummaries(rawSummaries, metadata)
            repository.persistCanonicalOutput(
                CanonicalSleepSummaryOutput(
                    date = date,
                    algorithmVersion = CANONICAL_SLEEP_SUMMARY_ALGORITHM_VERSION,
                    computedAt = computedAt,
                    summaries = canonical.map(::toOutput),
                )
            )
        }
    }

    private fun toOutput(row: SleepSummaryRow): CanonicalSleepSummaryRowOutput =
        CanonicalSleepSummaryRowOutput(
            sleepSummaryId = row.id,
            sourceInstanceId = row.sourceInstanceId,
            startAt = Instant.parse(row.startAt),
            endAt = Instant.parse(row.endAt),
        )
}

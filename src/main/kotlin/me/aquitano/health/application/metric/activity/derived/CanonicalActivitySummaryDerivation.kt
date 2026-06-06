package me.aquitano.health.application.metric.activity.derived

import me.aquitano.health.application.CanonicalMetricFamily
import me.aquitano.health.application.CanonicalMetricsPolicy
import me.aquitano.health.application.metric.activity.repository.ActivitySummaryRow
import me.aquitano.health.application.metric.activity.repository.CanonicalActivityOutput
import me.aquitano.health.application.metric.activity.repository.CanonicalActivitySummaryDerivationRepository
import me.aquitano.health.application.metric.activity.repository.CanonicalActivitySummaryOutput
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import java.time.Instant
import java.time.LocalDate

const val CANONICAL_ACTIVITY_ALGORITHM_VERSION = 1

class CanonicalActivitySummaryDerivationService(
    private val repository: CanonicalActivitySummaryDerivationRepository,
    private val policy: CanonicalMetricsPolicy = CanonicalMetricsPolicy.default(),
) {
    suspend fun recompute(dates: Set<LocalDate>, computedAt: Instant) {
        dates.forEach { date ->
            val rawSummaries = repository.listRawSummariesForDay(date)
            val metadata = repository.sourceMetadataFor(rawSummaries.map { it.sourceInstanceId }.toSet())
            val canonical = canonicalActivitySummaries(rawSummaries, metadata)

            repository.persistCanonicalOutput(
                CanonicalActivityOutput(
                    date = date,
                    algorithmVersion = CANONICAL_ACTIVITY_ALGORITHM_VERSION,
                    computedAt = computedAt,
                    summary = canonical.singleOrNull()?.let {
                        CanonicalActivitySummaryOutput(
                            activitySummaryId = it.id,
                            sourceInstanceId = it.sourceInstanceId,
                            date = date,
                        )
                    },
                )
            )
        }
    }

    fun canonicalActivitySummaries(
        rows: List<ActivitySummaryRow>,
        metadata: Map<Int, SourceMetadata>,
    ): List<ActivitySummaryRow> =
        rows.map { row ->
            PreparedCanonicalActivitySummary(
                row = row,
                providerRank = policy.rank(CanonicalMetricFamily.ACTIVITY, metadata[row.sourceInstanceId]?.provider),
                fieldCount = activityFieldCount(row),
            )
        }
            .groupBy { it.row.date }
            .values
            .map { candidates ->
                candidates.minWithOrNull(
                    compareBy<PreparedCanonicalActivitySummary> { it.providerRank }
                        .thenByDescending { it.fieldCount }
                        .thenBy { it.row.id }
                )!!.row
            }
            .sortedWith(compareBy<ActivitySummaryRow> { it.date }.thenBy { it.id })

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
}

private data class PreparedCanonicalActivitySummary(
    val row: ActivitySummaryRow,
    val providerRank: Int,
    val fieldCount: Int,
)

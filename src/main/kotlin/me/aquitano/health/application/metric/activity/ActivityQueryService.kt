package me.aquitano.health.application.metric.activity

import me.aquitano.health.api.dto.ActivitySummariesResponse
import me.aquitano.health.api.dto.ActivitySummaryLatestResponse
import me.aquitano.health.application.CanonicalMetricFamily
import me.aquitano.health.application.CanonicalMetricsPolicy
import me.aquitano.health.application.metric.activity.repository.ActivitySummaryRepository
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.dailyLatestReadFilters
import me.aquitano.health.application.metric.common.dailyReadFilters
import me.aquitano.health.application.metric.common.meta
import me.aquitano.health.application.metric.common.sourceInstanceIds
import me.aquitano.health.application.metric.common.toResponse
import me.aquitano.health.application.metric.activity.repository.ActivitySummaryRow
import org.jetbrains.exposed.v1.jdbc.Database
import java.time.Instant

class ActivityQueryService(
    database: Database,
    private val activitySummaryRepository: ActivitySummaryRepository,
    private val policy: CanonicalMetricsPolicy = CanonicalMetricsPolicy.default(),
) : BaseReadService(database) {
    suspend fun listActivitySummaries(
        params: QueryParams,
        now: Instant,
    ): ActivitySummariesResponse =
        dbQuery {
            val filters = params.dailyReadFilters(now)
            val (rawRows, sourceMetadata) = activitySummaryRepository.listActivitySummaries(filters)
            val rows = canonicalActivitySummaries(
                rawRows,
                activitySummaryRepository.sourceMetadataFor(rawRows.sourceInstanceIds { it.sourceInstanceId }),
            )
            ActivitySummariesResponse(
                items = rows.map { it.toResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }

    suspend fun latestActivitySummary(
        params: QueryParams,
        now: Instant,
    ): ActivitySummaryLatestResponse =
        dbQuery {
            val filters = params.dailyLatestReadFilters(now)
            val (rows, sourceMetadata) = activitySummaryRepository.listActivitySummaries(
                filters.copy(limit = Int.MAX_VALUE),
            )
            val canonicalRows = canonicalActivitySummaries(
                rows,
                activitySummaryRepository.sourceMetadataFor(rows.sourceInstanceIds { it.sourceInstanceId }),
            )
            val row = canonicalRows.maxWithOrNull(compareBy<ActivitySummaryRow> { it.date }.thenBy { it.id })
            ActivitySummaryLatestResponse(item = row?.toResponse(sourceMetadata))
        }
    private fun canonicalActivitySummaries(
        rows: List<ActivitySummaryRow>,
        metadata: Map<Int, me.aquitano.health.application.metric.common.repository.SourceMetadata>,
    ): List<ActivitySummaryRow> =
        rows.groupBy { it.date }
            .values
            .map { candidates ->
                candidates.minWithOrNull(
                    compareBy<ActivitySummaryRow> { policy.rank(CanonicalMetricFamily.ACTIVITY, metadata[it.sourceInstanceId]?.provider) }
                        .thenByDescending { activityFieldCount(it) }
                        .thenBy { it.id }
                )!!
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


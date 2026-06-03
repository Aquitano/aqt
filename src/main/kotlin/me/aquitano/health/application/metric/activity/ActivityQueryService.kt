package me.aquitano.health.application.metric.activity

import me.aquitano.health.api.dto.ActivitySummariesResponse
import me.aquitano.health.api.dto.ActivitySummaryLatestResponse
import me.aquitano.health.application.CanonicalMetricsService
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
    private val activitySummaryRepository: ActivitySummaryRepository = ActivitySummaryRepository(),
    private val canonicalMetricsService: CanonicalMetricsService,
) : BaseReadService(database) {
    suspend fun listActivitySummaries(
        params: QueryParams,
        now: Instant,
    ): ActivitySummariesResponse =
        dbQuery {
            val filters = params.dailyReadFilters(now)
            val canonical = params.canonical(default = false)
            val (rawRows, sourceMetadata) = activitySummaryRepository.listActivitySummaries(filters)
            val rows = if (canonical) {
                canonicalMetricsService.canonicalActivitySummaries(
                    rawRows,
                    activitySummaryRepository.sourceMetadataFor(rawRows.sourceInstanceIds { it.sourceInstanceId }),
                )
            } else {
                rawRows
            }
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
            val canonical = params.canonical(default = true)
            val (row, sourceMetadata) = if (canonical) {
                val (rows, metadata) = activitySummaryRepository.listActivitySummaries(
                    filters.copy(limit = Int.MAX_VALUE),
                )
                val canonicalRows = canonicalMetricsService.canonicalActivitySummaries(
                    rows,
                    activitySummaryRepository.sourceMetadataFor(rows.sourceInstanceIds { it.sourceInstanceId }),
                )
                canonicalRows.maxWithOrNull(compareBy<ActivitySummaryRow> { it.date }.thenBy { it.id }) to metadata
            } else {
                activitySummaryRepository.latestActivitySummary(filters)
            }
            ActivitySummaryLatestResponse(item = row?.toResponse(sourceMetadata))
        }
}


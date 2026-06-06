package me.aquitano.health.application.metric.activity

import me.aquitano.health.api.dto.ActivitySummariesResponse
import me.aquitano.health.api.dto.ActivitySummaryLatestResponse
import me.aquitano.health.application.metric.activity.derived.CANONICAL_ACTIVITY_ALGORITHM_VERSION
import me.aquitano.health.application.metric.activity.repository.CanonicalActivitySummaryDerivationRepository
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.dailyLatestReadFilters
import me.aquitano.health.application.metric.common.dailyReadFilters
import me.aquitano.health.application.metric.common.meta
import me.aquitano.health.application.metric.common.toResponse
import org.jetbrains.exposed.v1.jdbc.Database
import java.time.Instant

class ActivityQueryService(
    database: Database,
    private val canonicalRepository: CanonicalActivitySummaryDerivationRepository,
) : BaseReadService(database) {
    suspend fun listActivitySummaries(
        params: QueryParams,
        now: Instant,
    ): ActivitySummariesResponse =
        dbQuery {
            val filters = params.dailyReadFilters(now)
            val (rows, sourceMetadata) =
                canonicalRepository.listCanonicalActivitySummaries(filters, CANONICAL_ACTIVITY_ALGORITHM_VERSION)
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
            val (rows, sourceMetadata) = canonicalRepository.listCanonicalActivitySummaries(
                filters.copy(limit = Int.MAX_VALUE),
                CANONICAL_ACTIVITY_ALGORITHM_VERSION,
            )
            val row = rows.maxWithOrNull(compareBy { it.date })
            ActivitySummaryLatestResponse(item = row?.toResponse(sourceMetadata))
        }
}


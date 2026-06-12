package me.aquitano.health.application.metric.activity

import me.aquitano.health.api.dto.ActivitySummariesResponse
import me.aquitano.health.application.metric.activity.repository.CanonicalActivitySummaryDerivationRepository
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.dailyLatestReadFilters
import me.aquitano.health.application.metric.common.dailyReadFilters
import me.aquitano.health.application.metric.common.keysetPage
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
            val latest = params.boolean("latest", default = false)
            val filters =
                if (latest) params.dailyLatestReadFilters(now) else params.dailyReadFilters(now)
            val (rows, sourceMetadata) =
                canonicalRepository.listCanonicalActivitySummaries(filters)
            val page = rows.keysetPage(
                limit = filters.limit,
                sort = filters.sort,
                order = filters.order,
                sortValue = { it.date },
                id = { it.id.toLong() },
            )
            ActivitySummariesResponse(
                items = page.items.map { it.toResponse(sourceMetadata) },
                meta = page.items.meta(filters, if (latest) null else page.nextCursor),
            )
        }
}

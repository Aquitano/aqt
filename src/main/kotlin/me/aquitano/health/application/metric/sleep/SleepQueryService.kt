package me.aquitano.health.application.metric.sleep

import me.aquitano.health.api.dto.SleepNightsResponse
import me.aquitano.health.api.dto.SleepSessionsResponse
import me.aquitano.health.application.SleepNightService
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.SortFields
import me.aquitano.health.application.metric.common.keysetPage
import me.aquitano.health.application.metric.common.meta
import me.aquitano.health.application.metric.common.readFilters
import me.aquitano.health.application.metric.common.sleepNightReadFilters
import me.aquitano.health.application.metric.common.sourceInstanceIds
import me.aquitano.health.application.metric.common.toResponse
import me.aquitano.health.application.metric.sleep.repository.SleepRepository
import me.aquitano.health.application.metric.sleep.repository.SleepSessionRow
import me.aquitano.health.application.metric.sleep.repository.CanonicalSleepSessionDerivationRepository
import me.aquitano.health.application.metric.sleep.repository.SleepNightRow
import me.aquitano.health.application.metric.sleep.repository.SleepStageRow
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import org.jetbrains.exposed.v1.jdbc.Database
import java.time.Instant

class SleepQueryService(
    database: Database,
    private val sleepRepository: SleepRepository,
    private val canonicalSessionRepository: CanonicalSleepSessionDerivationRepository,
    private val sleepNightService: SleepNightService,
) : BaseReadService(database) {
    suspend fun listSleepSessions(params: QueryParams): SleepSessionsResponse =
        dbQuery {
            val filters = params.readFilters(
                defaultSort = SortFields.START_AT,
                allowedSorts = setOf(SortFields.START_AT),
                latestSupported = true,
            )
            val (sessions, sourceMetadata) =
                canonicalSessionRepository.listCanonicalSleepSessions(filters)
            val page = sessions.keysetPage(
                limit = filters.limit,
                sort = filters.sort,
                order = filters.order,
                sortValue = { it.startAt },
                id = { it.id.toLong() },
            )
            val stagesBySession =
                canonicalSessionRepository.listRawStagesForSessions(page.items.map { it.id }.toSet())
            SleepSessionsResponse(
                items = page.items.map { session ->
                    session.toResponse(stagesBySession, sourceMetadata)
                },
                meta = page.items.meta(filters, page.nextCursor),
            )
        }

    suspend fun listSleepNights(
        params: QueryParams,
        now: Instant,
    ): SleepNightsResponse =
        dbQuery {
            params.rejectLatest()
            val filters = params.sleepNightReadFilters(now)
            sleepNightService.materialize(filters, now)
            val (nights, stagesBySession, sourceMetadata) =
                sleepRepository.listCanonicalSleepNights(filters)
            val page = nights.keysetPage(
                limit = filters.limit,
                sort = filters.sort,
                order = filters.order,
                sortValue = { it.date },
                id = { it.session.id.toLong() },
            )
            SleepNightsResponse(
                items = page.items.map { night ->
                    night.toResponse(stagesBySession, sourceMetadata)
                },
                meta = page.items.meta(filters, page.nextCursor),
            )
        }
}

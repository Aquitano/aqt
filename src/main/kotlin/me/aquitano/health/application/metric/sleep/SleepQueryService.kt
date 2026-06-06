package me.aquitano.health.application.metric.sleep

import me.aquitano.health.api.dto.SleepNightsResponse
import me.aquitano.health.api.dto.SleepSessionsResponse
import me.aquitano.health.application.CanonicalMetricsService
import me.aquitano.health.application.SleepNightService
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.SortFields
import me.aquitano.health.application.metric.common.meta
import me.aquitano.health.application.metric.common.readFilters
import me.aquitano.health.application.metric.common.sleepNightReadFilters
import me.aquitano.health.application.metric.common.sourceInstanceIds
import me.aquitano.health.application.metric.common.toResponse
import me.aquitano.health.application.metric.sleep.repository.SleepRepository
import me.aquitano.health.application.metric.sleep.repository.SleepSessionRow
import me.aquitano.health.application.metric.sleep.repository.SleepNightRow
import me.aquitano.health.application.metric.sleep.repository.SleepStageRow
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import org.jetbrains.exposed.v1.jdbc.Database
import java.time.Instant

class SleepQueryService(
    database: Database,
    private val sleepRepository: SleepRepository,
    private val canonicalMetricsService: CanonicalMetricsService,
    private val sleepNightService: SleepNightService,
) : BaseReadService(database) {
    suspend fun listSleepSessions(params: QueryParams): SleepSessionsResponse =
        dbQuery {
            val filters = params.readFilters(
                defaultSort = SortFields.START_AT,
                allowedSorts = setOf(SortFields.START_AT),
                latestSupported = true,
            )
            val (rawSessions, stagesBySession, sourceMetadata) =
                sleepRepository.listSleepSessions(filters)
            val sessions = canonicalMetricsService.canonicalSleepSessions(
                rawSessions,
                stagesBySession,
                sleepRepository.sourceMetadataFor(rawSessions.sourceInstanceIds { it.sourceInstanceId }),
            )
            SleepSessionsResponse(
                items = sessions.map { session ->
                    session.toResponse(stagesBySession, sourceMetadata)
                },
                meta = sessions.meta(filters),
            )
        }

    suspend fun listSleepNights(
        params: QueryParams,
        now: Instant,
    ): SleepNightsResponse =
        dbQuery {
            params.rejectLatest()
            val filters = params.sleepNightReadFilters(now)
            sleepNightService.materializeCanonical(filters, now)
            val (nights, stagesBySession, sourceMetadata) =
                sleepRepository.listCanonicalSleepNights(filters)
            SleepNightsResponse(
                items = nights.map { night ->
                    night.toResponse(stagesBySession, sourceMetadata)
                },
                meta = nights.meta(filters),
            )
        }
}


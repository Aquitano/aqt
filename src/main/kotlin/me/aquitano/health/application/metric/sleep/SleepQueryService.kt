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
import me.aquitano.health.infrastructure.repositories.MetricsReadRepository
import org.jetbrains.exposed.v1.jdbc.Database
import java.time.Instant

class SleepQueryService(
    database: Database,
    private val metricsReadRepository: MetricsReadRepository,
    private val canonicalMetricsService: CanonicalMetricsService,
    private val sleepNightService: SleepNightService,
) : BaseReadService(database) {
    suspend fun listSleepSessions(params: QueryParams): SleepSessionsResponse =
        dbQuery {
            val canonical = params.canonical(default = params.boolean("latest", default = false))
            val filters = params.readFilters(
                defaultSort = SortFields.START_AT,
                allowedSorts = setOf(SortFields.START_AT),
                latestSupported = true,
            )
            val (rawSessions, stagesBySession, sourceMetadata) =
                metricsReadRepository.listSleepSessions(filters)
            val sessions = if (canonical) {
                canonicalMetricsService.canonicalSleepSessions(
                    rawSessions,
                    stagesBySession,
                    metricsReadRepository.sourceMetadataFor(rawSessions.sourceInstanceIds { it.sourceInstanceId }),
                )
            } else {
                rawSessions
            }
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
            sleepNightService.materialize(filters, now)
            val canonical = params.canonical(default = false)
            val (rawNights, stagesBySession, sourceMetadata) =
                metricsReadRepository.listSleepNights(filters)
            val canonicalSessionIds = if (canonical) {
                canonicalMetricsService.canonicalSleepSessions(
                    rawNights.map { it.session },
                    stagesBySession,
                    metricsReadRepository.sourceMetadataFor(
                        rawNights.map { it.session }.sourceInstanceIds { it.sourceInstanceId },
                    ),
                ).map { it.id }.toSet()
            } else {
                rawNights.map { it.session.id }.toSet()
            }
            val nights = rawNights.filter { it.session.id in canonicalSessionIds }
            SleepNightsResponse(
                items = nights.map { night ->
                    night.toResponse(stagesBySession, sourceMetadata)
                },
                meta = nights.meta(filters),
            )
        }
}


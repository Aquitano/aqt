package me.aquitano.health.application.metric.dashboard

import me.aquitano.health.api.dto.DashboardStepsSummaryResponse
import me.aquitano.health.api.dto.DashboardSummaryResponse
import me.aquitano.health.application.CanonicalMetricsService
import me.aquitano.health.application.SleepNightService
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.Orders
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.SortFields
import me.aquitano.health.application.metric.common.sourceInstanceIds
import me.aquitano.health.application.metric.common.toResponse
import me.aquitano.health.application.metric.common.validateDateRange
import me.aquitano.health.application.singleSource
import me.aquitano.health.domain.BodyMetricTypes
import me.aquitano.health.infrastructure.repositories.BodyMeasurementRow
import me.aquitano.health.infrastructure.repositories.DailyReadFilters
import me.aquitano.health.infrastructure.repositories.HeartRateSampleRow
import me.aquitano.health.infrastructure.repositories.MetricsReadRepository
import me.aquitano.health.infrastructure.repositories.ReadFilters
import me.aquitano.health.infrastructure.repositories.SleepNightReadFilters
import me.aquitano.health.infrastructure.repositories.SleepSessionRow
import org.jetbrains.exposed.v1.jdbc.Database
import java.time.Instant
import java.time.ZoneOffset

private const val DashboardSummaryLatestCandidateLimit = 500

class DashboardQueryService(
    database: Database,
    private val metricsReadRepository: MetricsReadRepository,
    private val canonicalMetricsService: CanonicalMetricsService,
    private val sleepNightService: SleepNightService,
) : BaseReadService(database) {
    suspend fun dashboardSummary(
        params: QueryParams,
        now: Instant,
    ): DashboardSummaryResponse {
        val fromDate = params.requiredDate("fromDate")
        val toDate = params.requiredDate("toDate")
        validateDateRange(fromDate, toDate)
        val includeSource = params.boolean("includeSource", default = false)
        val canonical = params.canonical(default = true)
        val fromInstant = fromDate.atStartOfDay().toInstant(ZoneOffset.UTC)
        val toInstant = toDate.plusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC)

        return dbQuery {
            val dailyFilters = DailyReadFilters(
                fromDate = fromDate,
                toDate = toDate,
                provider = params.optional("provider"),
                providerInstanceId = params.optional("providerInstanceId"),
                includeSource = false,
                limit = 1,
                sort = SortFields.DATE,
                order = Orders.ASC,
            )
            val instantFilters = ReadFilters(
                from = fromInstant,
                to = toInstant,
                provider = params.optional("provider"),
                providerInstanceId = params.optional("providerInstanceId"),
                includeSource = includeSource,
                limit = 1,
                sort = SortFields.MEASURED_AT,
                order = Orders.DESC,
            )
            val sleepNightFilters = SleepNightReadFilters(
                fromDate = toDate,
                toDate = toDate,
                timezone = params.timezone(),
                provider = params.optional("provider"),
                providerInstanceId = params.optional("providerInstanceId"),
                includeSource = includeSource,
                limit = 1,
                sort = SortFields.DATE,
                order = Orders.ASC,
            )

            sleepNightService.materialize(sleepNightFilters, now)
            DashboardSummaryResponse(
                fromDate = fromDate.toString(),
                toDate = toDate.toString(),
                steps = stepsSummary(dailyFilters, includeSource, canonical),
                latestWeight = latestWeight(instantFilters, canonical),
                latestHeartRate = latestHeartRate(instantFilters, canonical),
                lastSleepSession = lastSleepSession(sleepNightFilters, canonical),
            )
        }
    }

    private fun stepsSummary(
        filters: DailyReadFilters,
        includeSource: Boolean,
        canonical: Boolean,
    ): DashboardStepsSummaryResponse =
        if (canonical) {
            val (rows) = metricsReadRepository.listStepDailySummaries(
                filters.copy(limit = Int.MAX_VALUE),
            )
            val canonicalRows = canonicalMetricsService.canonicalStepDailySummaries(
                rows,
                metricsReadRepository.sourceMetadataFor(rows.sourceInstanceIds { it.sourceInstanceId }),
            )
            DashboardStepsSummaryResponse(
                steps = canonicalRows.sumOf { it.steps },
                sampleCount = canonicalRows.sumOf { it.sampleCount },
                source = canonicalRows.singleSource(
                    includeSource,
                    metricsReadRepository,
                ) { it.sourceInstanceId },
            )
        } else {
            metricsReadRepository.sumStepDailySummaries(filters).let {
                DashboardStepsSummaryResponse(
                    steps = it.steps,
                    sampleCount = it.sampleCount,
                )
            }
        }

    private fun latestWeight(
        filters: ReadFilters,
        canonical: Boolean,
    ) = if (canonical) {
        val (rows, metadata) = metricsReadRepository.listBodyMeasurements(
            filters.copy(
                limit = DashboardSummaryLatestCandidateLimit,
                order = Orders.DESC,
            ),
            BodyMetricTypes.WEIGHT,
        )
        val canonicalRows = canonicalMetricsService.canonicalBodyMeasurements(
            rows,
            metricsReadRepository.sourceMetadataFor(rows.sourceInstanceIds { it.sourceInstanceId }),
        )
        canonicalRows.maxWithOrNull(compareBy<BodyMeasurementRow> { it.measuredAt }.thenBy { it.id })
            ?.toResponse(metadata)
    } else {
        val (row, metadata) = metricsReadRepository.latestBodyMeasurement(
            filters,
            BodyMetricTypes.WEIGHT,
        )
        row?.toResponse(metadata)
    }

    private fun latestHeartRate(
        filters: ReadFilters,
        canonical: Boolean,
    ) = if (canonical) {
        val (rows, metadata) = metricsReadRepository.listHeartRateSamples(
            filters.copy(
                limit = DashboardSummaryLatestCandidateLimit,
                order = Orders.DESC,
            ),
        )
        val canonicalRows = canonicalMetricsService.canonicalHeartRateSamples(
            rows,
            metricsReadRepository.sourceMetadataFor(rows.sourceInstanceIds { it.sourceInstanceId }),
        )
        canonicalRows.maxWithOrNull(compareBy<HeartRateSampleRow> { it.measuredAt }.thenBy { it.id })
            ?.toResponse(metadata)
    } else {
        val (row, metadata) = metricsReadRepository.latestHeartRateSample(filters)
        row?.toResponse(metadata)
    }

    private fun lastSleepSession(
        filters: SleepNightReadFilters,
        canonical: Boolean,
    ) = metricsReadRepository.listSleepNights(
        filters.copy(
            limit = if (canonical) DashboardSummaryLatestCandidateLimit else filters.limit,
            order = Orders.DESC,
        )
    ).let { (sleepNights, sleepStagesBySession, sleepSourceMetadata) ->
        val sleep = if (canonical) {
            canonicalMetricsService.canonicalSleepSessions(
                sleepNights.map { it.session },
                sleepStagesBySession,
                metricsReadRepository.sourceMetadataFor(
                    sleepNights.map { it.session }.sourceInstanceIds { it.sourceInstanceId },
                ),
            ).maxWithOrNull(compareBy<SleepSessionRow> { it.endAt }.thenBy { it.id })
        } else {
            sleepNights.firstOrNull()?.session
        }
        sleep?.toResponse(sleepStagesBySession, sleepSourceMetadata)
    }
}


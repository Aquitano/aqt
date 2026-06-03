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
import me.aquitano.health.application.metric.heart.derived.CANONICAL_HEART_RATE_ALGORITHM_VERSION
import me.aquitano.health.application.metric.heart.repository.CanonicalHeartRateDerivationRepository
import me.aquitano.health.application.singleSource
import me.aquitano.health.domain.BodyMetricTypes
import me.aquitano.health.application.metric.body.repository.BodyMeasurementRow
import me.aquitano.health.application.metric.common.repository.DailyReadFilters
import me.aquitano.health.application.metric.heart.repository.HeartRateSampleRow
import me.aquitano.health.application.metric.common.repository.ReadFilters
import me.aquitano.health.application.metric.common.repository.SleepNightReadFilters
import me.aquitano.health.application.metric.steps.repository.StepRepository
import me.aquitano.health.application.metric.sleep.repository.SleepRepository
import me.aquitano.health.application.metric.body.repository.BodyMeasurementRepository
import me.aquitano.health.application.metric.heart.repository.HeartRateRepository
import org.jetbrains.exposed.v1.jdbc.Database
import java.time.Instant
import java.time.ZoneOffset

private const val DashboardSummaryLatestCandidateLimit = 500

class DashboardQueryService(
    database: Database,
    private val stepRepository: StepRepository,
    private val sleepRepository: SleepRepository,
    private val bodyMeasurementRepository: BodyMeasurementRepository,
    private val heartRateRepository: HeartRateRepository,
    private val canonicalHeartRateRepository: CanonicalHeartRateDerivationRepository = CanonicalHeartRateDerivationRepository(),
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

            if (canonical) {
                sleepNightService.materializeCanonical(sleepNightFilters, now)
            } else {
                sleepNightService.materialize(sleepNightFilters, now)
            }
            DashboardSummaryResponse(
                fromDate = fromDate.toString(),
                toDate = toDate.toString(),
                steps = stepsSummary(dailyFilters, includeSource, canonical),
                latestWeight = latestWeight(dailyFilters.toReadFilters(fromInstant, toInstant), canonical),
                latestHeartRate = latestHeartRate(dailyFilters.toReadFilters(fromInstant, toInstant), canonical),
                lastSleepSession = lastSleepSession(sleepNightFilters, canonical),
            )
        }
    }

    private fun DailyReadFilters.toReadFilters(from: Instant, to: Instant): ReadFilters =
        ReadFilters(
            from = from,
            to = to,
            provider = provider,
            providerInstanceId = providerInstanceId,
            includeSource = includeSource,
            limit = 1,
            sort = SortFields.MEASURED_AT,
            order = Orders.DESC,
        )

    private fun stepsSummary(
        filters: DailyReadFilters,
        includeSource: Boolean,
        canonical: Boolean,
    ): DashboardStepsSummaryResponse =
        if (canonical) {
            val (rows) = stepRepository.listStepDailySummaries(
                filters.copy(limit = Int.MAX_VALUE),
            )
            val canonicalRows = canonicalMetricsService.canonicalStepDailySummaries(
                rows,
                stepRepository.sourceMetadataFor(rows.sourceInstanceIds { it.sourceInstanceId }),
            )
            DashboardStepsSummaryResponse(
                steps = canonicalRows.sumOf { it.steps },
                sampleCount = canonicalRows.sumOf { it.sampleCount },
                source = canonicalRows.singleSource(
                    includeSource,
                    stepRepository,
                ) { it.sourceInstanceId },
            )
        } else {
            stepRepository.sumStepDailySummaries(filters).let {
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
        val (rows, metadata) = bodyMeasurementRepository.listBodyMeasurements(
            filters.copy(
                limit = DashboardSummaryLatestCandidateLimit,
                order = Orders.DESC,
            ),
            BodyMetricTypes.WEIGHT,
        )
        val canonicalRows = canonicalMetricsService.canonicalBodyMeasurements(
            rows,
            bodyMeasurementRepository.sourceMetadataFor(rows.sourceInstanceIds { it.sourceInstanceId }),
        )
        canonicalRows.maxWithOrNull(compareBy<BodyMeasurementRow> { it.measuredAt }.thenBy { it.id })
            ?.toResponse(metadata)
    } else {
        val (row, metadata) = bodyMeasurementRepository.latestBodyMeasurement(
            filters,
            BodyMetricTypes.WEIGHT,
        )
        row?.toResponse(metadata)
    }

    private suspend fun latestHeartRate(
        filters: ReadFilters,
        canonical: Boolean,
    ) = if (canonical) {
        val canonicalFilters = filters.copy(
            limit = DashboardSummaryLatestCandidateLimit,
            order = Orders.DESC,
        )
        val (canonicalRows, metadata) = canonicalHeartRateRepository.listCanonicalHeartRateSamples(
            canonicalFilters,
            CANONICAL_HEART_RATE_ALGORITHM_VERSION,
        )
        canonicalRows.maxWithOrNull(compareBy<HeartRateSampleRow> { it.measuredAt }.thenBy { it.id })
            ?.toResponse(metadata)
    } else {
        val (row, metadata) = heartRateRepository.latestHeartRateSample(filters)
        row?.toResponse(metadata)
    }

    private fun lastSleepSession(
        filters: SleepNightReadFilters,
        canonical: Boolean,
    ) = (
        if (canonical) {
            sleepRepository.listCanonicalSleepNights(
                filters.copy(
                    limit = filters.limit,
                    order = Orders.DESC,
                )
            )
        } else {
            sleepRepository.listSleepNights(
                filters.copy(
                    limit = filters.limit,
                    order = Orders.DESC,
                )
            )
        }
        ).let { (sleepNights, sleepStagesBySession, sleepSourceMetadata) ->
        val sleep = sleepNights.firstOrNull()?.session
        sleep?.toResponse(sleepStagesBySession, sleepSourceMetadata)
    }
}

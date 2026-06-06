package me.aquitano.health.application.metric.dashboard

import me.aquitano.health.api.dto.DashboardStepsSummaryResponse
import me.aquitano.health.api.dto.DashboardSummaryResponse
import me.aquitano.health.application.SleepNightService
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.Orders
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.SortFields
import me.aquitano.health.application.metric.common.toResponse
import me.aquitano.health.application.metric.common.validateDateRange
import me.aquitano.health.application.metric.heart.derived.CANONICAL_HEART_RATE_ALGORITHM_VERSION
import me.aquitano.health.application.metric.body.derived.CANONICAL_BODY_MEASUREMENT_ALGORITHM_VERSION
import me.aquitano.health.application.metric.body.repository.CanonicalBodyMeasurementDerivationRepository
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.application.metric.heart.repository.CanonicalHeartRateDerivationRepository
import me.aquitano.health.domain.BodyMetricTypes
import me.aquitano.health.application.metric.common.repository.DailyReadFilters
import me.aquitano.health.application.metric.common.repository.ReadFilters
import me.aquitano.health.application.metric.common.repository.SleepNightReadFilters
import me.aquitano.health.application.metric.steps.derived.CANONICAL_STEP_ALGORITHM_VERSION
import me.aquitano.health.application.metric.steps.repository.CanonicalStepDerivationRepository
import me.aquitano.health.application.metric.sleep.repository.SleepRepository
import org.jetbrains.exposed.v1.jdbc.Database
import java.time.Instant
import java.time.ZoneOffset

class DashboardQueryService(
    database: Database,
    private val canonicalStepRepository: CanonicalStepDerivationRepository,
    private val sleepRepository: SleepRepository,
    private val canonicalHeartRateRepository: CanonicalHeartRateDerivationRepository = CanonicalHeartRateDerivationRepository(),
    private val canonicalBodyMeasurementRepository: CanonicalBodyMeasurementDerivationRepository =
        CanonicalBodyMeasurementDerivationRepository(),
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

            sleepNightService.materializeCanonical(sleepNightFilters, now)
            DashboardSummaryResponse(
                fromDate = fromDate.toString(),
                toDate = toDate.toString(),
                steps = stepsSummary(dailyFilters),
                latestWeight = latestWeight(dailyFilters.toReadFilters(fromInstant, toInstant)),
                latestHeartRate = latestHeartRate(dailyFilters.toReadFilters(fromInstant, toInstant)),
                lastSleepSession = lastSleepSession(sleepNightFilters),
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
    ): DashboardStepsSummaryResponse {
        val (summary, sourceMetadata) = canonicalStepRepository.summarizeCanonicalStepsForDashboard(
            filters,
            CANONICAL_STEP_ALGORITHM_VERSION,
        )
        return DashboardStepsSummaryResponse(
            steps = summary.steps,
            sampleCount = summary.sampleCount,
            source = summary.sourceInstanceIds.singleSource(sourceMetadata),
        )
    }

    private fun latestWeight(
        filters: ReadFilters,
    ) = run {
        val (row, metadata) = canonicalBodyMeasurementRepository.latestCanonicalBodyMeasurement(
            filters,
            BodyMetricTypes.WEIGHT,
            CANONICAL_BODY_MEASUREMENT_ALGORITHM_VERSION,
        )
        row?.toResponse(metadata)
    }

    private suspend fun latestHeartRate(
        filters: ReadFilters,
    ) = run {
        val (row, metadata) = canonicalHeartRateRepository.latestCanonicalHeartRateSample(
            filters,
            CANONICAL_HEART_RATE_ALGORITHM_VERSION,
        )
        row?.toResponse(metadata)
    }

    private fun lastSleepSession(
        filters: SleepNightReadFilters,
    ) = sleepRepository.listCanonicalSleepNights(
        filters.copy(
            limit = filters.limit,
            order = Orders.DESC,
        )
    )
        .let { (sleepNights, sleepStagesBySession, sleepSourceMetadata) ->
            val sleep = sleepNights.firstOrNull()?.session
            sleep?.toResponse(sleepStagesBySession, sleepSourceMetadata)
        }

    private fun Set<Int>.singleSource(
        sourceMetadata: Map<Int, SourceMetadata>,
    ) = if (size == 1) sourceMetadata[first()].toResponse() else null
}

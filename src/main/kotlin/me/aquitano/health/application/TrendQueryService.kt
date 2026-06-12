package me.aquitano.health.application

import me.aquitano.health.api.dto.*
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.domain.BodyMetricTypes
import me.aquitano.health.domain.ScalarMetricTypes
import me.aquitano.health.application.metric.common.repository.DailyReadFilters
import me.aquitano.health.application.metric.common.repository.ReadFilters
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.shared.utcDate
import me.aquitano.health.application.metric.steps.repository.StepRepository
import me.aquitano.health.application.metric.scalar.ScalarSampleReadRepository
import me.aquitano.health.application.metric.scalar.ScalarSampleRow
import me.aquitano.health.application.metric.sleep.repository.SleepRepository
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.transactions.suspendTransaction
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import kotlin.math.roundToInt

class TrendQueryService(
    private val database: Database,
    private val stepRepository: StepRepository,
    private val sleepRepository: SleepRepository,
    private val scalarRepository: ScalarSampleReadRepository = ScalarSampleReadRepository(),
) {

    suspend fun dashboardTrends(
        params: QueryParams,
        now: Instant,
    ): DashboardTrendsResponse = dbQuery {
        val periodDays = params.optional("periodDays")?.toIntOrNull()?.coerceIn(1, 90) ?: 7
        val toDate = params.date("toDate") ?: now.utcDate()
        val fromDate = toDate.minusDays(periodDays.toLong() - 1)
        val previousToDate = fromDate.minusDays(1)
        val previousFromDate = previousToDate.minusDays(periodDays.toLong() - 1)

        val steps = stepsTrend(fromDate, toDate, previousFromDate, previousToDate, periodDays)
        val heartRate = heartRateTrend(fromDate, toDate, previousFromDate, previousToDate)
        val sleep = sleepTrend(fromDate, toDate, previousFromDate, previousToDate)
        val weight = weightTrend(toDate)

        DashboardTrendsResponse(
            periodDays = periodDays,
            steps = steps,
            heartRate = heartRate,
            sleep = sleep,
            weight = weight,
        )
    }

    private fun stepsTrend(
        currentFrom: LocalDate,
        currentTo: LocalDate,
        previousFrom: LocalDate,
        previousTo: LocalDate,
        periodDays: Int,
    ): StepsTrend? {
        val current = stepRepository.sumStepDailySummaries(
            dailyReadFilters(currentFrom, currentTo)
        )
        val previous = stepRepository.sumStepDailySummaries(
            dailyReadFilters(previousFrom, previousTo)
        )
        if (current.sampleCount == 0 && previous.sampleCount == 0) return null
        val dailyAverage = if (current.sampleCount > 0) current.steps / current.sampleCount else 0
        return StepsTrend(
            currentTotal = current.steps,
            previousTotal = previous.steps,
            percentChange = percentChange(current.steps.toDouble(), previous.steps.toDouble()),
            dailyAverage = dailyAverage,
        )
    }

    private fun heartRateTrend(
        currentFrom: LocalDate,
        currentTo: LocalDate,
        previousFrom: LocalDate,
        previousTo: LocalDate,
    ): HeartRateTrend? {
        val currentSummary = scalarRepository.summarize(
            readFilters(currentFrom, currentTo),
            setOf(ScalarMetricTypes.HEART_RATE),
            canonical = false,
        )
        val previousSummary = scalarRepository.summarize(
            readFilters(previousFrom, previousTo),
            setOf(ScalarMetricTypes.HEART_RATE),
            canonical = false,
        )
        if (currentSummary.count == 0 && previousSummary.count == 0) return null
        val currentAvg = currentSummary.avgValue ?: 0.0
        val previousAvg = previousSummary.avgValue ?: 0.0
        return HeartRateTrend(
            currentAvg = roundToOneDecimal(currentAvg),
            previousAvg = roundToOneDecimal(previousAvg),
            percentChange = percentChange(currentAvg, previousAvg),
        )
    }

    private fun sleepTrend(
        currentFrom: LocalDate,
        currentTo: LocalDate,
        previousFrom: LocalDate,
        previousTo: LocalDate,
    ): SleepTrend? {
        val currentAvg = sleepRepository.avgSleepDuration(
            readFilters(currentFrom, currentTo)
        )
        val previousAvg = sleepRepository.avgSleepDuration(
            readFilters(previousFrom, previousTo)
        )
        if (currentAvg == null && previousAvg == null) return null
        val current = currentAvg ?: 0L
        val previous = previousAvg ?: 0L
        return SleepTrend(
            currentAvgSeconds = current,
            previousAvgSeconds = previous,
            percentChange = percentChange(current.toDouble(), previous.toDouble()),
        )
    }

    private fun weightTrend(toDate: LocalDate): WeightTrend? {
        val current = scalarRepository.latestBefore(
            before = toDate.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant(),
            metricType = BodyMetricTypes.WEIGHT,
        )
        if (current == null) return null
        val previous = scalarRepository.latestBefore(
            before = current.measuredAt,
            metricType = BodyMetricTypes.WEIGHT,
        )
        val delta = if (previous != null) roundToOneDecimal(current.value - previous.value) else null
        val percentChange = if (previous != null && previous.value != 0.0) {
            percentChange(current.value, previous.value)
        } else null

        val sourceMetadata = scalarRepository.sourceMetadataFor(
            setOf(current.sourceInstanceId)
        )
        val currentResponse = current.toResponse(sourceMetadata)
        val previousResponse = previous?.toResponse(sourceMetadata)

        return WeightTrend(
            latest = currentResponse,
            previous = previousResponse,
            delta = delta,
            percentChange = percentChange,
        )
    }

    private fun dailyReadFilters(fromDate: LocalDate, toDate: LocalDate): DailyReadFilters =
        DailyReadFilters(
            fromDate = fromDate,
            toDate = toDate,
            provider = null,
            providerInstanceId = null,
            includeSource = false,
            limit = Int.MAX_VALUE,
            sort = "date",
            order = "asc",
        )

    private fun readFilters(fromDate: LocalDate, toDate: LocalDate): ReadFilters =
        ReadFilters(
            from = fromDate.atStartOfDay(ZoneOffset.UTC).toInstant(),
            to = toDate.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant(),
            provider = null,
            providerInstanceId = null,
            includeSource = false,
            limit = Int.MAX_VALUE,
            sort = "measuredAt",
            order = "asc",
        )

    private fun percentChange(current: Double, previous: Double): Double {
        if (previous == 0.0) return if (current > 0) 100.0 else 0.0
        return roundToOneDecimal(((current - previous) / previous) * 100.0)
    }

    private fun roundToOneDecimal(value: Double): Double =
        (value * 10.0).roundToInt() / 10.0

    private fun ScalarSampleRow.toResponse(
        sourceMetadata: Map<Int, SourceMetadata>
    ): ScalarSampleResponse =
        ScalarSampleResponse(
            id = id,
            measuredAt = measuredAt.toString(),
            metricType = metricType,
            value = value,
            unit = unit,
            context = context,
            segment = segment,
            source = sourceMetadata[sourceInstanceId]?.let {
                SourceMetadataResponse(
                    provider = it.provider,
                    providerInstanceId = it.providerInstanceId,
                )
            },
        )

    private suspend fun <T> dbQuery(block: suspend () -> T): T =
        suspendTransaction(db = database) { block() }
}

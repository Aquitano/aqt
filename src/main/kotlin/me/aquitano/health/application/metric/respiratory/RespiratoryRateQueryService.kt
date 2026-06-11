package me.aquitano.health.application.metric.respiratory

import me.aquitano.health.api.dto.RespiratoryRateSamplesResponse
import me.aquitano.health.api.dto.RespiratoryRateSummaryResponse
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.SortFields
import me.aquitano.health.application.metric.common.meta
import me.aquitano.health.application.metric.common.readFilters
import me.aquitano.health.application.metric.common.summaryFilters
import me.aquitano.health.application.metric.scalar.ScalarSampleReadRepository
import me.aquitano.health.application.metric.scalar.toRespiratoryRateResponse
import me.aquitano.health.domain.ScalarMetricTypes
import org.jetbrains.exposed.v1.jdbc.Database
import kotlin.math.roundToInt

class RespiratoryRateQueryService(
    database: Database,
    private val scalarRepository: ScalarSampleReadRepository = ScalarSampleReadRepository(),
) : BaseReadService(database) {
    private val metricTypes = setOf(ScalarMetricTypes.RESPIRATORY_RATE)

    suspend fun listRespiratoryRateSamples(params: QueryParams): RespiratoryRateSamplesResponse =
        dbQuery {
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rows, sourceMetadata) = scalarRepository.list(filters, metricTypes, canonical = true)
            RespiratoryRateSamplesResponse(
                items = rows.map { it.toRespiratoryRateResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }

    suspend fun respiratoryRateSummary(params: QueryParams): RespiratoryRateSummaryResponse =
        dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val summary = scalarRepository.summarize(filters, metricTypes, canonical = true)
            val (latest, sourceMetadata) = scalarRepository.latest(filters, metricTypes, canonical = true)
            RespiratoryRateSummaryResponse(
                count = summary.count,
                minBreathsPerMinute = summary.minValue?.roundToInt(),
                maxBreathsPerMinute = summary.maxValue?.roundToInt(),
                avgBreathsPerMinute = summary.avgValue,
                latest = latest?.toRespiratoryRateResponse(sourceMetadata),
            )
        }
}

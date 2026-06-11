package me.aquitano.health.application.metric.heart

import me.aquitano.health.api.dto.HeartRateSamplesResponse
import me.aquitano.health.api.dto.HeartRateSummaryResponse
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.SortFields
import me.aquitano.health.application.metric.common.meta
import me.aquitano.health.application.metric.common.readFilters
import me.aquitano.health.application.metric.common.summaryFilters
import me.aquitano.health.application.metric.scalar.ScalarSampleReadRepository
import me.aquitano.health.application.metric.scalar.toHeartRateResponse
import me.aquitano.health.domain.ScalarMetricTypes
import org.jetbrains.exposed.v1.jdbc.Database
import kotlin.math.roundToInt

class HeartRateQueryService(
    database: Database,
    private val scalarRepository: ScalarSampleReadRepository = ScalarSampleReadRepository(),
) : BaseReadService(database) {
    private val metricTypes = setOf(ScalarMetricTypes.HEART_RATE)

    suspend fun listHeartRateSamples(params: QueryParams): HeartRateSamplesResponse =
        dbQuery {
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rows, sourceMetadata) = scalarRepository.list(filters, metricTypes, canonical = true)
            HeartRateSamplesResponse(
                items = rows.map { it.toHeartRateResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }

    suspend fun heartRateSummary(params: QueryParams): HeartRateSummaryResponse =
        dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val summary = scalarRepository.summarize(filters, metricTypes, canonical = true)
            val (latest, sourceMetadata) = scalarRepository.latest(filters, metricTypes, canonical = true)
            HeartRateSummaryResponse(
                count = summary.count,
                minBpm = summary.minValue?.roundToInt(),
                maxBpm = summary.maxValue?.roundToInt(),
                avgBpm = summary.avgValue,
                latest = latest?.toHeartRateResponse(sourceMetadata),
            )
        }
}

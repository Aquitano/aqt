package me.aquitano.health.application.metric.hrv

import me.aquitano.health.api.dto.HrvSamplesResponse
import me.aquitano.health.api.dto.HrvSummaryResponse
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.SortFields
import me.aquitano.health.application.metric.common.meta
import me.aquitano.health.application.metric.common.readFilters
import me.aquitano.health.application.metric.common.summaryFilters
import me.aquitano.health.application.metric.common.validateHrvMetricType
import me.aquitano.health.application.metric.scalar.ScalarSampleReadRepository
import me.aquitano.health.application.metric.scalar.toHrvResponse
import me.aquitano.health.domain.HrvMetricTypes
import org.jetbrains.exposed.v1.jdbc.Database

class HrvQueryService(
    database: Database,
    private val scalarRepository: ScalarSampleReadRepository = ScalarSampleReadRepository(),
) : BaseReadService(database) {
    suspend fun listHrvSamples(params: QueryParams): HrvSamplesResponse {
        val metricType = params.optional("metricType") ?: HrvMetricTypes.RMSSD
        validateHrvMetricType(metricType)
        return dbQuery {
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rows, sourceMetadata) =
                scalarRepository.list(filters, setOf("hrv_$metricType"), canonical = true)
            HrvSamplesResponse(
                items = rows.map { it.toHrvResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }
    }

    suspend fun hrvSummary(params: QueryParams): HrvSummaryResponse {
        val metricType = params.optional("metricType") ?: HrvMetricTypes.RMSSD
        validateHrvMetricType(metricType)
        return dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val scalarTypes = setOf("hrv_$metricType")
            val summary = scalarRepository.summarize(filters, scalarTypes, canonical = true)
            val (latest, sourceMetadata) = scalarRepository.latest(filters, scalarTypes, canonical = true)
            HrvSummaryResponse(
                count = summary.count,
                metricType = metricType,
                minValue = summary.minValue,
                maxValue = summary.maxValue,
                avgValue = summary.avgValue,
                latest = latest?.toHrvResponse(sourceMetadata),
            )
        }
    }
}

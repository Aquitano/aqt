package me.aquitano.health.application.metric.hrv

import me.aquitano.health.api.dto.HrvSamplesResponse
import me.aquitano.health.api.dto.HrvSummaryResponse
import me.aquitano.health.application.metric.hrv.derived.CANONICAL_HRV_ALGORITHM_VERSION
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.Orders
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.SortFields
import me.aquitano.health.application.metric.common.hrvSummary
import me.aquitano.health.application.metric.common.meta
import me.aquitano.health.application.metric.common.readFilters
import me.aquitano.health.application.metric.common.summaryFilters
import me.aquitano.health.application.metric.common.toResponse
import me.aquitano.health.application.metric.common.validateHrvMetricType
import me.aquitano.health.application.metric.hrv.repository.CanonicalHrvDerivationRepository
import me.aquitano.health.application.metric.hrv.repository.HrvSampleRow
import me.aquitano.health.domain.HrvMetricTypes
import org.jetbrains.exposed.v1.jdbc.Database

class HrvQueryService(
    database: Database,
    private val canonicalRepository: CanonicalHrvDerivationRepository = CanonicalHrvDerivationRepository(),
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
            val (rows, sourceMetadata) = canonicalRepository.listCanonicalHrvSamples(
                filters,
                metricType,
                CANONICAL_HRV_ALGORITHM_VERSION,
            )
            HrvSamplesResponse(
                items = rows.map { it.toResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }
    }

    suspend fun hrvSummary(params: QueryParams): HrvSummaryResponse {
        val metricType = params.optional("metricType") ?: HrvMetricTypes.RMSSD
        validateHrvMetricType(metricType)
        return dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val canonicalFilters = filters.copy(limit = Int.MAX_VALUE, order = Orders.ASC)
            val (canonicalRows, sourceMetadata) = canonicalRepository.listCanonicalHrvSamples(
                canonicalFilters,
                metricType,
                CANONICAL_HRV_ALGORITHM_VERSION,
            )
            val summary = canonicalRows.hrvSummary()
            val latest = canonicalRows.maxWithOrNull(compareBy<HrvSampleRow> { it.measuredAt }.thenBy { it.id })
            HrvSummaryResponse(
                count = summary.count,
                metricType = metricType,
                minValue = summary.minValue,
                maxValue = summary.maxValue,
                avgValue = summary.avgValue,
                latest = latest?.toResponse(sourceMetadata),
            )
        }
    }
}


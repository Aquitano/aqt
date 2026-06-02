package me.aquitano.health.application.metric.hrv

import me.aquitano.health.api.dto.HrvSamplesResponse
import me.aquitano.health.api.dto.HrvSummaryResponse
import me.aquitano.health.application.CanonicalMetricsService
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.Orders
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.SortFields
import me.aquitano.health.application.metric.common.hrvSummary
import me.aquitano.health.application.metric.common.meta
import me.aquitano.health.application.metric.common.readFilters
import me.aquitano.health.application.metric.common.sourceInstanceIds
import me.aquitano.health.application.metric.common.summaryFilters
import me.aquitano.health.application.metric.common.toResponse
import me.aquitano.health.application.metric.common.validateHrvMetricType
import me.aquitano.health.domain.HrvMetricTypes
import me.aquitano.health.infrastructure.repositories.HrvSampleRow
import me.aquitano.health.infrastructure.repositories.MetricsReadRepository
import org.jetbrains.exposed.v1.jdbc.Database

class HrvQueryService(
    database: Database,
    private val metricsReadRepository: MetricsReadRepository,
    private val canonicalMetricsService: CanonicalMetricsService,
) : BaseReadService(database) {
    suspend fun listHrvSamples(params: QueryParams): HrvSamplesResponse {
        val metricType = params.optional("metricType") ?: HrvMetricTypes.RMSSD
        validateHrvMetricType(metricType)
        return dbQuery {
            val canonical = params.canonical(default = params.boolean("latest", default = false))
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rawRows, sourceMetadata) = metricsReadRepository.listHrvSamples(filters, metricType)
            val rows = if (canonical) {
                canonicalMetricsService.canonicalHrvSamples(
                    rawRows,
                    metricsReadRepository.sourceMetadataFor(rawRows.sourceInstanceIds { it.sourceInstanceId }),
                )
            } else {
                rawRows
            }
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
            val canonical = params.canonical(default = true)
            val (summary, latest, sourceMetadata) = if (canonical) {
                val (rows, metadata) = metricsReadRepository.listHrvSamples(
                    filters.copy(limit = Int.MAX_VALUE, order = Orders.ASC),
                    metricType,
                )
                val canonicalRows = canonicalMetricsService.canonicalHrvSamples(
                    rows,
                    metricsReadRepository.sourceMetadataFor(rows.sourceInstanceIds { it.sourceInstanceId }),
                )
                Triple(
                    canonicalRows.hrvSummary(),
                    canonicalRows.maxWithOrNull(compareBy<HrvSampleRow> { it.measuredAt }.thenBy { it.id }),
                    metadata,
                )
            } else {
                val (latest, metadata) = metricsReadRepository.latestHrvSample(filters, metricType)
                Triple(metricsReadRepository.summarizeHrv(filters, metricType), latest, metadata)
            }
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


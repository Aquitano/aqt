package me.aquitano.health.application.metric.respiratory

import me.aquitano.health.api.dto.RespiratoryRateSamplesResponse
import me.aquitano.health.api.dto.RespiratoryRateSummaryResponse
import me.aquitano.health.application.CanonicalMetricsService
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.Orders
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.SortFields
import me.aquitano.health.application.metric.common.meta
import me.aquitano.health.application.metric.common.readFilters
import me.aquitano.health.application.metric.common.respiratoryRateSummary
import me.aquitano.health.application.metric.common.sourceInstanceIds
import me.aquitano.health.application.metric.common.summaryFilters
import me.aquitano.health.application.metric.common.toResponse
import me.aquitano.health.infrastructure.repositories.MetricsReadRepository
import me.aquitano.health.infrastructure.repositories.RespiratoryRateSampleRow
import org.jetbrains.exposed.v1.jdbc.Database

class RespiratoryRateQueryService(
    database: Database,
    private val metricsReadRepository: MetricsReadRepository,
    private val canonicalMetricsService: CanonicalMetricsService,
) : BaseReadService(database) {
    suspend fun listRespiratoryRateSamples(params: QueryParams): RespiratoryRateSamplesResponse =
        dbQuery {
            val canonical = params.canonical(default = params.boolean("latest", default = false))
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rawRows, sourceMetadata) = metricsReadRepository.listRespiratoryRateSamples(filters)
            val rows = if (canonical) {
                canonicalMetricsService.canonicalRespiratoryRateSamples(
                    rawRows,
                    metricsReadRepository.sourceMetadataFor(rawRows.sourceInstanceIds { it.sourceInstanceId }),
                )
            } else {
                rawRows
            }
            RespiratoryRateSamplesResponse(
                items = rows.map { it.toResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }

    suspend fun respiratoryRateSummary(params: QueryParams): RespiratoryRateSummaryResponse =
        dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val canonical = params.canonical(default = true)
            val (summary, latest, sourceMetadata) = if (canonical) {
                val (rows, metadata) = metricsReadRepository.listRespiratoryRateSamples(
                    filters.copy(limit = Int.MAX_VALUE, order = Orders.ASC),
                )
                val canonicalRows = canonicalMetricsService.canonicalRespiratoryRateSamples(
                    rows,
                    metricsReadRepository.sourceMetadataFor(rows.sourceInstanceIds { it.sourceInstanceId }),
                )
                Triple(
                    canonicalRows.respiratoryRateSummary(),
                    canonicalRows.maxWithOrNull(compareBy<RespiratoryRateSampleRow> { it.measuredAt }.thenBy { it.id }),
                    metadata,
                )
            } else {
                val (latest, metadata) = metricsReadRepository.latestRespiratoryRateSample(filters)
                Triple(metricsReadRepository.summarizeRespiratoryRate(filters), latest, metadata)
            }
            RespiratoryRateSummaryResponse(
                count = summary.count,
                minBreathsPerMinute = summary.minBreathsPerMinute,
                maxBreathsPerMinute = summary.maxBreathsPerMinute,
                avgBreathsPerMinute = summary.avgBreathsPerMinute,
                latest = latest?.toResponse(sourceMetadata),
            )
        }
}


package me.aquitano.health.application.metric.heart

import me.aquitano.health.api.dto.HeartRateSamplesResponse
import me.aquitano.health.api.dto.HeartRateSummaryResponse
import me.aquitano.health.application.CanonicalMetricsService
import me.aquitano.health.application.heartRateSummary
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.Orders
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.SortFields
import me.aquitano.health.application.metric.common.meta
import me.aquitano.health.application.metric.common.readFilters
import me.aquitano.health.application.metric.common.sourceInstanceIds
import me.aquitano.health.application.metric.common.summaryFilters
import me.aquitano.health.application.metric.common.toResponse
import me.aquitano.health.application.metric.heart.repository.HeartRateRepository
import me.aquitano.health.application.metric.heart.repository.HeartRateSampleRow
import org.jetbrains.exposed.v1.jdbc.Database

class HeartRateQueryService(
    database: Database,
    private val heartRateRepository: HeartRateRepository = HeartRateRepository(),
    private val canonicalMetricsService: CanonicalMetricsService,
) : BaseReadService(database) {
    suspend fun listHeartRateSamples(params: QueryParams): HeartRateSamplesResponse =
        dbQuery {
            val canonical = params.canonical(default = params.boolean("latest", default = false))
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rawRows, sourceMetadata) = heartRateRepository.listHeartRateSamples(filters)
            val rows = if (canonical) {
                canonicalMetricsService.canonicalHeartRateSamples(
                    rawRows,
                    heartRateRepository.sourceMetadataFor(rawRows.sourceInstanceIds { it.sourceInstanceId }),
                )
            } else {
                rawRows
            }
            HeartRateSamplesResponse(
                items = rows.map { it.toResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }

    suspend fun heartRateSummary(params: QueryParams): HeartRateSummaryResponse =
        dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val canonical = params.canonical(default = true)
            val (summary, latest, sourceMetadata) = if (canonical) {
                val (rows, metadata) = heartRateRepository.listHeartRateSamples(
                    filters.copy(limit = Int.MAX_VALUE, order = Orders.ASC),
                )
                val canonicalRows = canonicalMetricsService.canonicalHeartRateSamples(
                    rows,
                    heartRateRepository.sourceMetadataFor(rows.sourceInstanceIds { it.sourceInstanceId }),
                )
                Triple(
                    canonicalRows.heartRateSummary(),
                    canonicalRows.maxWithOrNull(compareBy<HeartRateSampleRow> { it.measuredAt }.thenBy { it.id }),
                    metadata,
                )
            } else {
                val (latest, metadata) = heartRateRepository.latestHeartRateSample(filters)
                Triple(heartRateRepository.summarizeHeartRate(filters), latest, metadata)
            }
            HeartRateSummaryResponse(
                count = summary.count,
                minBpm = summary.minBpm,
                maxBpm = summary.maxBpm,
                avgBpm = summary.avgBpm,
                latest = latest?.toResponse(sourceMetadata),
            )
        }
}


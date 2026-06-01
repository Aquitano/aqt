package me.aquitano.health.application

import me.aquitano.health.api.dto.SleepSummariesResponse
import me.aquitano.health.api.dto.SleepSummaryLatestResponse
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.sourceInstanceIds
import me.aquitano.health.application.metric.sleep.repository.SleepRepository
import me.aquitano.health.application.metric.sleep.repository.SleepSummaryRow
import org.jetbrains.exposed.v1.jdbc.Database

class SleepSummaryReadService(
    database: Database,
    private val sleepRepository: SleepRepository,
    private val canonicalMetricsService: CanonicalMetricsService,
) : BaseReadService(database) {
    suspend fun list(params: QueryParams): SleepSummariesResponse =
        dbQuery {
            val canonical = params.canonical(default = params.boolean("latest", default = false))
            val filters = params.readFilters(
                defaultSort = SortFields.END_AT,
                allowedSorts = setOf(SortFields.END_AT),
                latestSupported = true,
            )
            val (rawRows, sourceMetadata) =
                sleepRepository.listSleepSummaries(filters)
            val rows = if (canonical) {
                canonicalMetricsService.canonicalSleepSummaries(
                    rawRows,
                    sleepRepository.sourceMetadataFor(rawRows.sourceInstanceIds { it.sourceInstanceId }),
                )
            } else {
                rawRows
            }
            SleepSummariesResponse(
                items = rows.map { it.toResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }

    suspend fun latest(params: QueryParams): SleepSummaryLatestResponse =
        dbQuery {
            val filters = params.summaryFilters(SortFields.END_AT)
            val canonical = params.canonical(default = true)
            val (row, sourceMetadata) = if (canonical) {
                val (rows, metadata) = sleepRepository.listSleepSummaries(
                    filters.copy(limit = Int.MAX_VALUE, order = Orders.ASC)
                )
                val canonicalRows = canonicalMetricsService.canonicalSleepSummaries(
                    rows,
                    sleepRepository.sourceMetadataFor(rows.sourceInstanceIds { it.sourceInstanceId }),
                )
                canonicalRows.maxWithOrNull(compareBy<SleepSummaryRow> { it.endAt }.thenBy { it.id }) to metadata
            } else {
                sleepRepository.latestSleepSummary(filters)
            }
            SleepSummaryLatestResponse(item = row?.toResponse(sourceMetadata))
        }
}

package me.aquitano.health.application

import kotlinx.coroutines.Dispatchers
import me.aquitano.health.api.dto.SleepSummariesResponse
import me.aquitano.health.api.dto.SleepSummaryLatestResponse
import me.aquitano.health.infrastructure.repositories.MetricsReadRepository
import me.aquitano.health.infrastructure.repositories.SleepSummaryRow
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.transactions.experimental.newSuspendedTransaction

class SleepSummaryReadService(
    private val database: Database,
    private val metricsReadRepository: MetricsReadRepository,
    private val canonicalMetricsService: CanonicalMetricsService,
) {
    suspend fun list(params: QueryParams): SleepSummariesResponse =
        dbQuery {
            val canonical = params.canonical(default = params.boolean("latest", default = false))
            val filters = params.readFilters(
                defaultSort = SortFields.END_AT,
                allowedSorts = setOf(SortFields.END_AT),
                latestSupported = true,
            )
            val (rawRows, sourceMetadata) =
                metricsReadRepository.listSleepSummaries(filters)
            val rows = if (canonical) {
                canonicalMetricsService.canonicalSleepSummaries(
                    rawRows,
                    metricsReadRepository.sourceMetadataFor(rawRows.sourceIds { it.sourceInstanceId }),
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
                val (rows, metadata) = metricsReadRepository.listSleepSummaries(
                    filters.copy(limit = Int.MAX_VALUE, order = Orders.ASC)
                )
                val canonicalRows = canonicalMetricsService.canonicalSleepSummaries(
                    rows,
                    metricsReadRepository.sourceMetadataFor(rows.sourceIds { it.sourceInstanceId }),
                )
                canonicalRows.maxWithOrNull(compareBy<SleepSummaryRow> { it.endAt }.thenBy { it.id }) to metadata
            } else {
                metricsReadRepository.latestSleepSummary(filters)
            }
            SleepSummaryLatestResponse(item = row?.toResponse(sourceMetadata))
        }

    private suspend fun <T> dbQuery(block: () -> T): T =
        newSuspendedTransaction(Dispatchers.IO, db = database) {
            block()
        }
}

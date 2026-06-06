package me.aquitano.health.application

import me.aquitano.health.api.dto.SleepSummariesResponse
import me.aquitano.health.api.dto.SleepSummaryLatestResponse
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.SortFields
import me.aquitano.health.application.metric.common.meta
import me.aquitano.health.application.metric.common.readFilters
import me.aquitano.health.application.metric.common.summaryFilters
import me.aquitano.health.application.metric.common.toResponse
import me.aquitano.health.application.metric.sleep.derived.CANONICAL_SLEEP_SUMMARY_ALGORITHM_VERSION
import me.aquitano.health.application.metric.sleep.repository.CanonicalSleepSummaryDerivationRepository
import org.jetbrains.exposed.v1.jdbc.Database

class SleepSummaryReadService(
    database: Database,
    private val canonicalRepository: CanonicalSleepSummaryDerivationRepository,
) : BaseReadService(database) {
    suspend fun list(params: QueryParams): SleepSummariesResponse =
        dbQuery {
            val filters = params.readFilters(
                defaultSort = SortFields.END_AT,
                allowedSorts = setOf(SortFields.END_AT),
                latestSupported = true,
            )
            val (rows, sourceMetadata) = canonicalRepository.listCanonicalSleepSummaries(
                filters,
                CANONICAL_SLEEP_SUMMARY_ALGORITHM_VERSION,
            )
            SleepSummariesResponse(
                items = rows.map { it.toResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }

    suspend fun latest(params: QueryParams): SleepSummaryLatestResponse =
        dbQuery {
            val filters = params.summaryFilters(SortFields.END_AT)
            val (row, sourceMetadata) = canonicalRepository.latestCanonicalSleepSummary(
                filters,
                CANONICAL_SLEEP_SUMMARY_ALGORITHM_VERSION,
            )
            SleepSummaryLatestResponse(item = row?.toResponse(sourceMetadata))
        }
}

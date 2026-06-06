package me.aquitano.health.application.metric.heart

import me.aquitano.health.api.dto.HeartRateSamplesResponse
import me.aquitano.health.api.dto.HeartRateSummaryResponse
import me.aquitano.health.application.metric.heart.derived.CANONICAL_HEART_RATE_ALGORITHM_VERSION
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.SortFields
import me.aquitano.health.application.metric.common.meta
import me.aquitano.health.application.metric.common.readFilters
import me.aquitano.health.application.metric.common.summaryFilters
import me.aquitano.health.application.metric.common.toResponse
import me.aquitano.health.application.metric.heart.repository.CanonicalHeartRateDerivationRepository
import org.jetbrains.exposed.v1.jdbc.Database

class HeartRateQueryService(
    database: Database,
    private val canonicalRepository: CanonicalHeartRateDerivationRepository = CanonicalHeartRateDerivationRepository(),
) : BaseReadService(database) {
    suspend fun listHeartRateSamples(params: QueryParams): HeartRateSamplesResponse =
        dbQuery {
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rows, sourceMetadata) = canonicalRepository.listCanonicalHeartRateSamples(
                filters,
                CANONICAL_HEART_RATE_ALGORITHM_VERSION,
            )
            HeartRateSamplesResponse(
                items = rows.map { it.toResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }

    suspend fun heartRateSummary(params: QueryParams): HeartRateSummaryResponse =
        dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val summary = canonicalRepository.summarizeCanonicalHeartRate(
                filters,
                CANONICAL_HEART_RATE_ALGORITHM_VERSION,
            )
            val (latest, sourceMetadata) = canonicalRepository.latestCanonicalHeartRateSample(
                filters,
                CANONICAL_HEART_RATE_ALGORITHM_VERSION,
            )
            HeartRateSummaryResponse(
                count = summary.count,
                minBpm = summary.minBpm,
                maxBpm = summary.maxBpm,
                avgBpm = summary.avgBpm,
                latest = latest?.toResponse(sourceMetadata),
            )
        }
}


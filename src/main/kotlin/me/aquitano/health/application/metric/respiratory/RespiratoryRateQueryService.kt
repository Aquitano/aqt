package me.aquitano.health.application.metric.respiratory

import me.aquitano.health.api.dto.RespiratoryRateSamplesResponse
import me.aquitano.health.api.dto.RespiratoryRateSummaryResponse
import me.aquitano.health.application.metric.respiratory.derived.CANONICAL_RESPIRATORY_RATE_ALGORITHM_VERSION
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
import me.aquitano.health.application.metric.respiratory.repository.CanonicalRespiratoryRateDerivationRepository
import me.aquitano.health.application.metric.respiratory.repository.RespiratoryRateSampleRow
import org.jetbrains.exposed.v1.jdbc.Database

class RespiratoryRateQueryService(
    database: Database,
    private val canonicalRepository: CanonicalRespiratoryRateDerivationRepository =
        CanonicalRespiratoryRateDerivationRepository(),
) : BaseReadService(database) {
    suspend fun listRespiratoryRateSamples(params: QueryParams): RespiratoryRateSamplesResponse =
        dbQuery {
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rows, sourceMetadata) = canonicalRepository.listCanonicalRespiratoryRateSamples(
                filters,
                CANONICAL_RESPIRATORY_RATE_ALGORITHM_VERSION,
            )
            RespiratoryRateSamplesResponse(
                items = rows.map { it.toResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }

    suspend fun respiratoryRateSummary(params: QueryParams): RespiratoryRateSummaryResponse =
        dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val canonicalFilters = filters.copy(limit = Int.MAX_VALUE, order = Orders.ASC)
            val (canonicalRows, sourceMetadata) = canonicalRepository.listCanonicalRespiratoryRateSamples(
                canonicalFilters,
                CANONICAL_RESPIRATORY_RATE_ALGORITHM_VERSION,
            )
            val summary = canonicalRows.respiratoryRateSummary()
            val latest =
                canonicalRows.maxWithOrNull(compareBy<RespiratoryRateSampleRow> { it.measuredAt }.thenBy { it.id })
            RespiratoryRateSummaryResponse(
                count = summary.count,
                minBreathsPerMinute = summary.minBreathsPerMinute,
                maxBreathsPerMinute = summary.maxBreathsPerMinute,
                avgBreathsPerMinute = summary.avgBreathsPerMinute,
                latest = latest?.toResponse(sourceMetadata),
            )
        }
}


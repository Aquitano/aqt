package me.aquitano.health.application.metric.scalar

import me.aquitano.health.api.dto.MetricCatalogEntryResponse
import me.aquitano.health.api.dto.MetricTypeCatalogResponse
import me.aquitano.health.api.dto.ReadResponseMeta
import me.aquitano.health.api.dto.ScalarDailySummariesResponse
import me.aquitano.health.api.dto.ScalarDailySummaryResponse
import me.aquitano.health.api.dto.ScalarSamplesResponse
import me.aquitano.health.api.dto.ScalarSummaryResponse
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.Orders
import me.aquitano.health.application.metric.common.QueryParamSpecs
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.SortFields
import me.aquitano.health.application.metric.common.keysetPage
import me.aquitano.health.application.metric.common.meta
import me.aquitano.health.application.metric.common.readFilters
import me.aquitano.health.application.metric.common.summaryFilters
import me.aquitano.health.domain.NotFoundException
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ScalarMetricRegistry
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
import org.jetbrains.exposed.v1.jdbc.Database

/**
 * The one read surface for all scalar metrics: catalog from the registry, canonical
 * (or raw=true) keyset-paginated lists per metric type, and per-type summaries.
 * Unknown metric types are a 404, matching the catalog as the source of truth.
 */
class ScalarMetricQueryService(
    database: Database,
    private val scalarRepository: ScalarSampleReadRepository,
) : BaseReadService(database) {
    fun catalog(): MetricTypeCatalogResponse =
        MetricTypeCatalogResponse(
            items = ScalarMetricRegistry.descriptors.map {
                MetricCatalogEntryResponse(
                    metricType = it.metricType,
                    family = it.family,
                    unit = it.unit,
                    supportsSegment = it.supportsSegment,
                    contexts = it.allowedContexts?.sorted(),
                )
            },
        )

    suspend fun list(metricType: String, params: QueryParams): ScalarSamplesResponse {
        requireKnown(metricType)
        val raw = params.boolean(QueryParamSpecs.raw)
        return dbQuery {
            val filters = params.readFilters(
                sortSpec = QueryParamSpecs.sortByMeasuredAt,
                latestSupported = true,
            )
            val (rows, sourceMetadata) =
                scalarRepository.list(filters, setOf(metricType), canonical = !raw)
            val page = rows.keysetPage(
                limit = filters.limit,
                sort = filters.sort,
                order = filters.order,
                sortValue = { it.measuredAt.toString() },
                id = { it.id },
            )
            ScalarSamplesResponse(
                items = page.items.map { it.toScalarResponse(sourceMetadata) },
                meta = page.items.meta(filters, page.nextCursor),
            )
        }
    }

    suspend fun summary(metricType: String, params: QueryParams): ScalarSummaryResponse {
        requireKnown(metricType)
        return dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val summary = scalarRepository.summarize(filters, setOf(metricType), canonical = true)
            val (latest, sourceMetadata) =
                scalarRepository.latest(filters, setOf(metricType), canonical = true)
            ScalarSummaryResponse(
                metricType = metricType,
                count = summary.count,
                minValue = summary.minValue,
                maxValue = summary.maxValue,
                avgValue = summary.avgValue,
                latest = latest?.toScalarResponse(sourceMetadata),
            )
        }
    }

    suspend fun summaryDaily(metricType: String, params: QueryParams): ScalarDailySummariesResponse {
        requireKnown(metricType)
        return dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            if (filters.from == null && filters.to == null) {
                throw RequestValidationException(
                    listOf(
                        ValidationIssue(
                            field = "from",
                            code = ValidationIssueCodes.Required,
                            message = "at least one of from or to is required",
                        )
                    )
                )
            }
            val zone = params.timezone()
            val items = scalarRepository
                .summarizeDaily(filters, setOf(metricType), canonical = true, zone)
                .map {
                    ScalarDailySummaryResponse(
                        date = it.date.toString(),
                        count = it.count,
                        minValue = it.minValue,
                        maxValue = it.maxValue,
                        avgValue = it.avgValue,
                    )
                }
            ScalarDailySummariesResponse(
                items = items,
                meta = ReadResponseMeta(
                    count = items.size,
                    limit = items.size,
                    sort = SortFields.DATE,
                    order = Orders.ASC,
                ),
            )
        }
    }

    private fun requireKnown(metricType: String) {
        if (ScalarMetricRegistry.find(metricType) == null) {
            throw NotFoundException("Unknown metric type '$metricType'")
        }
    }
}

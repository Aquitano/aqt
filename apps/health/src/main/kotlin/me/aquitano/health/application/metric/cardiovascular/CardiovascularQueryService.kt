package me.aquitano.health.application.metric.cardiovascular

import me.aquitano.health.api.dto.BloodPressureMeasurementsResponse
import me.aquitano.health.application.metric.cardiovascular.repository.CardiovascularRepository
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.QueryParamSpecs
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.keysetPage
import me.aquitano.health.application.metric.common.meta
import me.aquitano.health.application.metric.common.readFilters
import me.aquitano.health.application.metric.common.toResponse
import org.jetbrains.exposed.v1.jdbc.Database

/**
 * Blood pressure is the one structural cardiovascular metric (paired systolic/diastolic
 * values); the scalar cardiovascular metrics are served by ScalarMetricQueryService.
 */
class CardiovascularQueryService(
    database: Database,
    private val cardiovascularRepository: CardiovascularRepository,
) : BaseReadService(database) {
    suspend fun listBloodPressure(params: QueryParams): BloodPressureMeasurementsResponse =
        dbQuery {
            val filters = params.readFilters(
                sortSpec = QueryParamSpecs.sortByMeasuredAt,
                latestSupported = true,
            )
            val (rows, sourceMetadata) = cardiovascularRepository.listBloodPressure(filters)
            val page = rows.keysetPage(
                limit = filters.limit,
                sort = filters.sort,
                order = filters.order,
                sortValue = { it.measuredAt },
                id = { it.id.toLong() },
            )
            BloodPressureMeasurementsResponse(
                items = page.items.map { it.toResponse(sourceMetadata) },
                meta = page.items.meta(filters, page.nextCursor),
            )
        }
}

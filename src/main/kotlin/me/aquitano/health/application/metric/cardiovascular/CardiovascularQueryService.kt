package me.aquitano.health.application.metric.cardiovascular

import me.aquitano.health.api.dto.BloodPressureLatestResponse
import me.aquitano.health.api.dto.BloodPressureMeasurementsResponse
import me.aquitano.health.api.dto.CardiovascularMeasurementResponse
import me.aquitano.health.api.dto.CardiovascularMeasurementsResponse
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.SortFields
import me.aquitano.health.application.metric.common.meta
import me.aquitano.health.application.metric.common.readFilters
import me.aquitano.health.application.metric.common.summaryFilters
import me.aquitano.health.application.metric.common.toResponse
import me.aquitano.health.application.metric.common.validateCardiovascularMetricType
import me.aquitano.health.infrastructure.repositories.MetricsReadRepository
import org.jetbrains.exposed.v1.jdbc.Database

class CardiovascularQueryService(
    database: Database,
    private val metricsReadRepository: MetricsReadRepository,
) : BaseReadService(database) {
    suspend fun listBloodPressure(params: QueryParams): BloodPressureMeasurementsResponse =
        dbQuery {
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rawRows, sourceMetadata) = metricsReadRepository.listBloodPressure(filters)
            BloodPressureMeasurementsResponse(
                items = rawRows.map { it.toResponse(sourceMetadata) },
                meta = rawRows.meta(filters),
            )
        }

    suspend fun latestBloodPressure(params: QueryParams): BloodPressureLatestResponse =
        dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val (row, sourceMetadata) = metricsReadRepository.latestBloodPressure(filters)
            BloodPressureLatestResponse(item = row?.toResponse(sourceMetadata))
        }

    suspend fun listCardiovascular(params: QueryParams): CardiovascularMeasurementsResponse {
        val metricType = params.optional("metricType")
        if (metricType != null) validateCardiovascularMetricType(metricType)
        return dbQuery {
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rawRows, sourceMetadata) = metricsReadRepository.listCardiovascular(filters, metricType)
            CardiovascularMeasurementsResponse(
                items = rawRows.map { it.toResponse(sourceMetadata) },
                meta = rawRows.meta(filters),
            )
        }
    }

    suspend fun latestCardiovascular(params: QueryParams): CardiovascularMeasurementResponse {
        val metricType = params.required("metricType")
        validateCardiovascularMetricType(metricType)
        return dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val (row, sourceMetadata) = metricsReadRepository.latestCardiovascular(filters, metricType)
            row!!.toResponse(sourceMetadata)
        }
    }
}


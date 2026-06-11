package me.aquitano.health.application.metric.cardiovascular

import me.aquitano.health.api.dto.BloodPressureLatestResponse
import me.aquitano.health.api.dto.BloodPressureMeasurementsResponse
import me.aquitano.health.api.dto.CardiovascularMeasurementResponse
import me.aquitano.health.api.dto.CardiovascularMeasurementsResponse
import me.aquitano.health.application.metric.cardiovascular.repository.CardiovascularRepository
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.SortFields
import me.aquitano.health.application.metric.common.meta
import me.aquitano.health.application.metric.common.readFilters
import me.aquitano.health.application.metric.common.summaryFilters
import me.aquitano.health.application.metric.common.toResponse
import me.aquitano.health.application.metric.common.validateCardiovascularMetricType
import me.aquitano.health.application.metric.scalar.ScalarSampleReadRepository
import me.aquitano.health.application.metric.scalar.toCardiovascularResponse
import me.aquitano.health.domain.NotFoundException
import me.aquitano.health.domain.ScalarMetricRegistry
import org.jetbrains.exposed.v1.jdbc.Database

class CardiovascularQueryService(
    database: Database,
    private val cardiovascularRepository: CardiovascularRepository,
    private val scalarRepository: ScalarSampleReadRepository = ScalarSampleReadRepository(),
) : BaseReadService(database) {
    suspend fun listBloodPressure(params: QueryParams): BloodPressureMeasurementsResponse =
        dbQuery {
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rawRows, sourceMetadata) = cardiovascularRepository.listBloodPressure(filters)
            BloodPressureMeasurementsResponse(
                items = rawRows.map { it.toResponse(sourceMetadata) },
                meta = rawRows.meta(filters),
            )
        }

    suspend fun latestBloodPressure(params: QueryParams): BloodPressureLatestResponse =
        dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val (row, sourceMetadata) = cardiovascularRepository.latestBloodPressure(filters)
            BloodPressureLatestResponse(item = row?.toResponse(sourceMetadata))
        }

    suspend fun listCardiovascular(params: QueryParams): CardiovascularMeasurementsResponse {
        val metricType = params.optional("metricType")
        if (metricType != null) validateCardiovascularMetricType(metricType)
        val metricTypes = metricType?.let { setOf(it) } ?: ScalarMetricRegistry.cardiovascularMetricTypes
        return dbQuery {
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rows, sourceMetadata) = scalarRepository.list(filters, metricTypes, canonical = false)
            CardiovascularMeasurementsResponse(
                items = rows.map { it.toCardiovascularResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }
    }

    suspend fun latestCardiovascular(params: QueryParams): CardiovascularMeasurementResponse {
        val metricType = params.required("metricType")
        validateCardiovascularMetricType(metricType)
        return dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val (row, sourceMetadata) =
                scalarRepository.latest(filters, setOf(metricType), canonical = false)
            row?.toCardiovascularResponse(sourceMetadata)
                ?: throw NotFoundException("No cardiovascular measurement found")
        }
    }
}

package me.aquitano.health.application.metric.body

import me.aquitano.health.api.dto.BodyMeasurementLatestResponse
import me.aquitano.health.api.dto.BodyMeasurementsResponse
import me.aquitano.health.api.dto.ExtendedBodyMeasurementResponse
import me.aquitano.health.api.dto.ExtendedBodyMeasurementsResponse
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.SortFields
import me.aquitano.health.application.metric.common.meta
import me.aquitano.health.application.metric.common.readFilters
import me.aquitano.health.application.metric.common.summaryFilters
import me.aquitano.health.application.metric.common.validateBodyMetricType
import me.aquitano.health.application.metric.scalar.ScalarSampleReadRepository
import me.aquitano.health.application.metric.scalar.toBodyMeasurementResponse
import me.aquitano.health.application.metric.scalar.toExtendedBodyMeasurementResponse
import me.aquitano.health.domain.NotFoundException
import me.aquitano.health.domain.ScalarMetricRegistry
import org.jetbrains.exposed.v1.jdbc.Database

class BodyMeasurementQueryService(
    database: Database,
    private val scalarRepository: ScalarSampleReadRepository = ScalarSampleReadRepository(),
) : BaseReadService(database) {
    suspend fun listBodyMeasurements(params: QueryParams): BodyMeasurementsResponse {
        val metricTypes = scalarTypes(params.optional("metricType"), ScalarMetricRegistry.bodyMetricTypes)
        return dbQuery {
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rows, sourceMetadata) = scalarRepository.list(filters, metricTypes, canonical = true)
            BodyMeasurementsResponse(
                items = rows.map { it.toBodyMeasurementResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }
    }

    suspend fun latestBodyMeasurement(params: QueryParams): BodyMeasurementLatestResponse {
        val metricType = params.required("metricType")
        validateBodyMetricType(metricType)
        return dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val (row, sourceMetadata) =
                scalarRepository.latest(filters, setOf(metricType), canonical = true)
            BodyMeasurementLatestResponse(item = row?.toBodyMeasurementResponse(sourceMetadata))
        }
    }

    suspend fun listExtendedBodyMeasurements(params: QueryParams): ExtendedBodyMeasurementsResponse {
        val metricTypes =
            scalarTypes(params.optional("metricType"), ScalarMetricRegistry.extendedBodyMetricTypes)
        return dbQuery {
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rows, sourceMetadata) = scalarRepository.list(filters, metricTypes, canonical = false)
            ExtendedBodyMeasurementsResponse(
                items = rows.map { it.toExtendedBodyMeasurementResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }
    }

    suspend fun latestExtendedBodyMeasurement(params: QueryParams): ExtendedBodyMeasurementResponse {
        val metricType = params.required("metricType")
        validateBodyMetricType(metricType)
        return dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val (row, sourceMetadata) =
                scalarRepository.latestBefore(filters, setOf(metricType), canonical = false)
            row?.toExtendedBodyMeasurementResponse(sourceMetadata)
                ?: throw NotFoundException("No extended body measurement found")
        }
    }

    /** Resolves the optional metricType filter against the endpoint's family default. */
    private fun scalarTypes(metricType: String?, familyDefault: Set<String>): Set<String> {
        if (metricType == null) return familyDefault
        validateBodyMetricType(metricType)
        return setOf(metricType)
    }
}

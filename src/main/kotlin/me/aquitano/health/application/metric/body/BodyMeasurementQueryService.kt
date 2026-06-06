package me.aquitano.health.application.metric.body

import me.aquitano.health.api.dto.BodyMeasurementLatestResponse
import me.aquitano.health.api.dto.BodyMeasurementsResponse
import me.aquitano.health.api.dto.ExtendedBodyMeasurementResponse
import me.aquitano.health.api.dto.ExtendedBodyMeasurementsResponse
import me.aquitano.health.application.metric.body.repository.BodyMeasurementRepository
import me.aquitano.health.application.metric.body.derived.CANONICAL_BODY_MEASUREMENT_ALGORITHM_VERSION
import me.aquitano.health.application.metric.body.repository.CanonicalBodyMeasurementDerivationRepository
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.SortFields
import me.aquitano.health.application.metric.common.meta
import me.aquitano.health.application.metric.common.readFilters
import me.aquitano.health.application.metric.common.summaryFilters
import me.aquitano.health.application.metric.common.toResponse
import me.aquitano.health.application.metric.common.validateBodyMetricType
import me.aquitano.health.domain.NotFoundException
import org.jetbrains.exposed.v1.jdbc.Database

class BodyMeasurementQueryService(
    database: Database,
    private val bodyMeasurementRepository: BodyMeasurementRepository,
    private val canonicalRepository: CanonicalBodyMeasurementDerivationRepository,
) : BaseReadService(database) {
    suspend fun listBodyMeasurements(params: QueryParams): BodyMeasurementsResponse {
        val metricType = params.optional("metricType")
        if (metricType != null) validateBodyMetricType(metricType)
        return dbQuery {
            val canonical = params.canonical(default = params.boolean("latest", default = false))
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rows, sourceMetadata) = if (canonical) {
                canonicalRepository.listCanonicalBodyMeasurements(
                    filters,
                    metricType,
                    CANONICAL_BODY_MEASUREMENT_ALGORITHM_VERSION,
                )
            } else {
                bodyMeasurementRepository.listBodyMeasurements(filters, metricType)
            }
            BodyMeasurementsResponse(
                items = rows.map { it.toResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }
    }

    suspend fun latestBodyMeasurement(params: QueryParams): BodyMeasurementLatestResponse {
        val metricType = params.required("metricType")
        validateBodyMetricType(metricType)
        return dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val canonical = params.canonical(default = true)
            val (row, sourceMetadata) =
                if (canonical) {
                    canonicalRepository.latestCanonicalBodyMeasurement(
                        filters,
                        metricType,
                        CANONICAL_BODY_MEASUREMENT_ALGORITHM_VERSION,
                    )
                } else {
                    bodyMeasurementRepository.latestBodyMeasurement(filters, metricType)
                }
            BodyMeasurementLatestResponse(item = row?.toResponse(sourceMetadata))
        }
    }

    suspend fun listExtendedBodyMeasurements(params: QueryParams): ExtendedBodyMeasurementsResponse {
        val metricType = params.optional("metricType")
        if (metricType != null) validateBodyMetricType(metricType)
        return dbQuery {
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rawRows, sourceMetadata) =
                bodyMeasurementRepository.listExtendedBodyMeasurements(filters, metricType)
            ExtendedBodyMeasurementsResponse(
                items = rawRows.map { it.toResponse(sourceMetadata) },
                meta = rawRows.meta(filters),
            )
        }
    }

    suspend fun latestExtendedBodyMeasurement(params: QueryParams): ExtendedBodyMeasurementResponse {
        val metricType = params.required("metricType")
        validateBodyMetricType(metricType)
        return dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val (row, sourceMetadata) =
                bodyMeasurementRepository.latestExtendedBodyMeasurementBefore(filters, metricType)
            row?.toResponse(sourceMetadata) ?: throw NotFoundException("No extended body measurement found")
        }
    }
}


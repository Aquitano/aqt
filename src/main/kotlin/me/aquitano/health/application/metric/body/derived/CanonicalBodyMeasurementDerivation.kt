package me.aquitano.health.application.metric.body.derived

import me.aquitano.health.application.CanonicalMetricsPolicy
import me.aquitano.health.application.CanonicalMetricsService
import me.aquitano.health.application.metric.body.repository.BodyMeasurementRow
import me.aquitano.health.application.metric.body.repository.CanonicalBodyMeasurementDerivationRepository
import me.aquitano.health.application.metric.body.repository.CanonicalBodyMeasurementOutput
import me.aquitano.health.application.metric.body.repository.CanonicalBodyMeasurementRowOutput
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

const val CANONICAL_BODY_MEASUREMENT_ALGORITHM_VERSION = 1

class CanonicalBodyMeasurementDerivationService(
    private val repository: CanonicalBodyMeasurementDerivationRepository,
    private val canonicalMetricsService: CanonicalMetricsService =
        CanonicalMetricsService(CanonicalMetricsPolicy.default()),
) {
    suspend fun recompute(dates: Set<LocalDate>, computedAt: Instant) {
        dates.forEach { date ->
            val dayStart = date.atStartOfDay().toInstant(ZoneOffset.UTC)
            val dayEnd = date.plusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC)
            val rawMeasurements = repository.listRawMeasurementsForDay(dayStart, dayEnd)
            val metadata = repository.sourceMetadataFor(rawMeasurements.map { it.sourceInstanceId }.toSet())
            val canonical = canonicalMetricsService.canonicalBodyMeasurements(rawMeasurements, metadata)
            repository.persistCanonicalOutput(
                CanonicalBodyMeasurementOutput(
                    date = date,
                    algorithmVersion = CANONICAL_BODY_MEASUREMENT_ALGORITHM_VERSION,
                    computedAt = computedAt,
                    measurements = canonical.map(::toOutput),
                )
            )
        }
    }

    private fun toOutput(row: BodyMeasurementRow): CanonicalBodyMeasurementRowOutput =
        CanonicalBodyMeasurementRowOutput(
            measurementId = row.id,
            sourceInstanceId = row.sourceInstanceId,
            measuredAt = Instant.parse(row.measuredAt),
            metricType = row.metricType,
        )
}

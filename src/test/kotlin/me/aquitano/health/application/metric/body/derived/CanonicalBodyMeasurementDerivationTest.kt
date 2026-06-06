package me.aquitano.health.application.metric.body.derived

import me.aquitano.health.application.metric.body.repository.BodyMeasurementRow
import me.aquitano.health.application.metric.body.repository.CanonicalBodyMeasurementDerivationRepository
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import kotlin.test.Test
import kotlin.test.assertEquals

class CanonicalBodyMeasurementDerivationTest {
    private val service = CanonicalBodyMeasurementDerivationService(CanonicalBodyMeasurementDerivationRepository())

    @Test
    fun `preserves same-source duplicates`() {
        val rows = listOf(row(id = 1, sourceInstanceId = 1), row(id = 2, sourceInstanceId = 1))

        val result = service.canonicalBodyMeasurements(
            rows = rows,
            metadata = mapOf(1 to SourceMetadata(provider = "withings", providerInstanceId = "w")),
        )

        assertEquals(listOf(1, 2), result.map { it.id })
    }

    @Test
    fun `prefers lower provider rank for cross-source conflicts`() {
        val rows = listOf(row(id = 1, sourceInstanceId = 1), row(id = 2, sourceInstanceId = 2))

        val result = service.canonicalBodyMeasurements(
            rows = rows,
            metadata = mapOf(
                1 to SourceMetadata(provider = "google_health", providerInstanceId = "g"),
                2 to SourceMetadata(provider = "withings", providerInstanceId = "w"),
            ),
        )

        assertEquals(listOf(2), result.map { it.id })
    }

    @Test
    fun `prefers lower id when provider rank ties`() {
        val rows = listOf(row(id = 2, sourceInstanceId = 2), row(id = 1, sourceInstanceId = 1))

        val result = service.canonicalBodyMeasurements(
            rows = rows,
            metadata = mapOf(
                1 to SourceMetadata(provider = "withings", providerInstanceId = "a"),
                2 to SourceMetadata(provider = "withings", providerInstanceId = "b"),
            ),
        )

        assertEquals(listOf(1), result.map { it.id })
    }

    private fun row(id: Int, sourceInstanceId: Int): BodyMeasurementRow =
        BodyMeasurementRow(
            id = id,
            sourceInstanceId = sourceInstanceId,
            measuredAt = "2024-01-01T00:00:00Z",
            metricType = "weight",
            value = 80.0,
            unit = "kg",
        )
}

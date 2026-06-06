package me.aquitano.health.application.metric.activity.derived

import me.aquitano.health.application.metric.activity.repository.ActivitySummaryRow
import me.aquitano.health.application.metric.activity.repository.CanonicalActivitySummaryDerivationRepository
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import kotlin.test.Test
import kotlin.test.assertEquals

class CanonicalActivitySummaryDerivationTest {
    private val service = CanonicalActivitySummaryDerivationService(CanonicalActivitySummaryDerivationRepository())

    @Test
    fun `prefers provider rank within a date`() {
        val result = service.canonicalActivitySummaries(
            rows = listOf(
                row(id = 1, sourceInstanceId = 1, distanceMeters = 1.0),
                row(id = 2, sourceInstanceId = 2, distanceMeters = 1.0),
            ),
            metadata = mapOf(
                1 to SourceMetadata(provider = "withings", providerInstanceId = "w"),
                2 to SourceMetadata(provider = "google_health", providerInstanceId = "g"),
            ),
        )

        assertEquals(listOf(2), result.map { it.id })
    }

    @Test
    fun `prefers richer row when provider rank ties`() {
        val result = service.canonicalActivitySummaries(
            rows = listOf(
                row(id = 1, sourceInstanceId = 1, distanceMeters = 1.0),
                row(id = 2, sourceInstanceId = 2, distanceMeters = 1.0, activeEnergyKcal = 100.0),
            ),
            metadata = mapOf(
                1 to SourceMetadata(provider = "google_health", providerInstanceId = "a"),
                2 to SourceMetadata(provider = "google_health", providerInstanceId = "b"),
            ),
        )

        assertEquals(listOf(2), result.map { it.id })
    }

    @Test
    fun `preserves one canonical row per date`() {
        val result = service.canonicalActivitySummaries(
            rows = listOf(
                row(id = 1, sourceInstanceId = 1, date = "2024-01-01"),
                row(id = 2, sourceInstanceId = 1, date = "2024-01-02"),
            ),
            metadata = mapOf(1 to SourceMetadata(provider = "google_health", providerInstanceId = "g")),
        )

        assertEquals(listOf(1, 2), result.map { it.id })
    }

    private fun row(
        id: Int,
        sourceInstanceId: Int,
        date: String = "2024-01-01",
        distanceMeters: Double? = null,
        activeEnergyKcal: Double? = null,
    ): ActivitySummaryRow =
        ActivitySummaryRow(
            id = id,
            sourceInstanceId = sourceInstanceId,
            date = date,
            distanceMeters = distanceMeters,
            activeEnergyKcal = activeEnergyKcal,
            totalEnergyKcal = null,
            elevationMeters = null,
            softMinutes = null,
            moderateMinutes = null,
            intenseMinutes = null,
            activeMinutes = null,
            averageHeartRateBpm = null,
            minHeartRateBpm = null,
            maxHeartRateBpm = null,
        )
}

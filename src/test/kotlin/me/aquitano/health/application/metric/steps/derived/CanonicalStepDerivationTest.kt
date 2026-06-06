package me.aquitano.health.application.metric.steps.derived

import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.application.metric.steps.repository.CanonicalStepDerivationRepository
import me.aquitano.health.application.metric.steps.repository.StepDailySummaryRow
import kotlin.test.Test
import kotlin.test.assertEquals

class CanonicalStepDerivationTest {
    private val service = CanonicalStepDerivationService(CanonicalStepDerivationRepository())

    @Test
    fun `daily summary prefers provider rank`() {
        val result = service.canonicalStepDailySummary(
            rows = listOf(
                row(id = 1, sourceInstanceId = 1, sampleCount = 100, steps = 1000),
                row(id = 2, sourceInstanceId = 2, sampleCount = 10, steps = 100),
            ),
            metadata = mapOf(
                1 to SourceMetadata(provider = "withings", providerInstanceId = "w"),
                2 to SourceMetadata(provider = "google_health", providerInstanceId = "g"),
            ),
        )

        assertEquals(2, result?.id)
    }

    @Test
    fun `daily summary prefers sample count then steps when provider rank ties`() {
        val sampleCountWinner = service.canonicalStepDailySummary(
            rows = listOf(
                row(id = 1, sourceInstanceId = 1, sampleCount = 10, steps = 2000),
                row(id = 2, sourceInstanceId = 2, sampleCount = 20, steps = 1000),
            ),
            metadata = metadataForGoogleSources(),
        )
        val stepsWinner = service.canonicalStepDailySummary(
            rows = listOf(
                row(id = 1, sourceInstanceId = 1, sampleCount = 10, steps = 1000),
                row(id = 2, sourceInstanceId = 2, sampleCount = 10, steps = 2000),
            ),
            metadata = metadataForGoogleSources(),
        )

        assertEquals(2, sampleCountWinner?.id)
        assertEquals(2, stepsWinner?.id)
    }

    @Test
    fun `daily summary prefers lower source instance id as final tie-break`() {
        val result = service.canonicalStepDailySummary(
            rows = listOf(
                row(id = 1, sourceInstanceId = 2, sampleCount = 10, steps = 1000),
                row(id = 2, sourceInstanceId = 1, sampleCount = 10, steps = 1000),
            ),
            metadata = metadataForGoogleSources(),
        )

        assertEquals(2, result?.id)
    }

    private fun row(
        id: Int,
        sourceInstanceId: Int,
        sampleCount: Int,
        steps: Int,
    ): StepDailySummaryRow =
        StepDailySummaryRow(
            id = id,
            sourceInstanceId = sourceInstanceId,
            date = "2024-01-01",
            steps = steps,
            sampleCount = sampleCount,
        )

    private fun metadataForGoogleSources(): Map<Int, SourceMetadata> =
        mapOf(
            1 to SourceMetadata(provider = "google_health", providerInstanceId = "a"),
            2 to SourceMetadata(provider = "google_health", providerInstanceId = "b"),
        )
}

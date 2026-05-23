package me.aquitano.health.application

import me.aquitano.health.infrastructure.repositories.*
import kotlin.test.Test
import kotlin.test.assertEquals

class CanonicalMetricsServiceTest {
    private val service = CanonicalMetricsService(CanonicalMetricsPolicy.default())
    private val metadata = mapOf(
        1 to SourceMetadata("health_connect", "pixel"),
        2 to SourceMetadata("withings", "scale"),
        3 to SourceMetadata("google_health", "google"),
    )

    @Test
    fun stepDailySummariesChooseOneSourcePerDate() {
        val rows = listOf(
            StepDailySummaryRow(1, "2026-04-19", 5000, 10),
            StepDailySummaryRow(2, "2026-04-19", 7000, 1),
        )

        val canonical = service.canonicalStepDailySummaries(rows, metadata)

        assertEquals(1, canonical.size)
        assertEquals(1, canonical.single().sourceInstanceId)
        assertEquals(5000, canonical.single().steps)
    }

    @Test
    fun stepSamplesPreserveNonOverlappingIntervalsAndResolveCrossSourceOverlaps() {
        val rows = listOf(
            StepSampleRow(1, 2, "2026-04-19T08:00:00Z", "2026-04-19T09:00:00Z", 1000),
            StepSampleRow(2, 1, "2026-04-19T08:30:00Z", "2026-04-19T09:30:00Z", 1200),
            StepSampleRow(3, 2, "2026-04-19T10:00:00Z", "2026-04-19T11:00:00Z", 800),
        )

        val canonical = service.canonicalStepSamples(rows, metadata)

        assertEquals(listOf(2, 3), canonical.map { it.id })
    }

    @Test
    fun stepSamplesKeepPairwiseWinnersAcrossBridgeOverlap() {
        val rows = listOf(
            StepSampleRow(1, 3, "2026-04-19T08:00:00Z", "2026-04-19T12:00:00Z", 2000),
            StepSampleRow(2, 3, "2026-04-19T09:00:00Z", "2026-04-19T10:00:00Z", 700),
            StepSampleRow(3, 2, "2026-04-19T09:30:00Z", "2026-04-19T11:00:00Z", 1000),
        )

        val canonical = service.canonicalStepSamples(rows, metadata)

        assertEquals(listOf(1, 2), canonical.map { it.id })
    }

    @Test
    fun richerSleepSessionWinsCrossSourceOverlap() {
        val rows = listOf(
            SleepSessionRow(1, 2, "2026-04-18T22:00:00Z", "2026-04-19T06:00:00Z", 28800),
            SleepSessionRow(2, 1, "2026-04-18T22:15:00Z", "2026-04-19T06:15:00Z", 28800),
            SleepSessionRow(3, 1, "2026-04-19T22:00:00Z", "2026-04-20T06:00:00Z", 28800),
        )
        val stages = mapOf(
            1 to listOf(stage("light"), stage("deep"), stage("rem")),
            2 to listOf(stage("asleep")),
            3 to listOf(stage("light")),
        )

        val canonical = service.canonicalSleepSessions(rows, stages, metadata)

        assertEquals(listOf(1, 3), canonical.map { it.id })
    }

    @Test
    fun sleepSessionsKeepPairwiseWinnersAcrossBridgeOverlap() {
        val rows = listOf(
            SleepSessionRow(1, 2, "2026-04-18T22:00:00Z", "2026-04-19T06:00:00Z", 28800),
            SleepSessionRow(2, 2, "2026-04-18T23:00:00Z", "2026-04-19T01:00:00Z", 7200),
            SleepSessionRow(3, 1, "2026-04-18T23:30:00Z", "2026-04-19T03:00:00Z", 12600),
        )
        val stages = mapOf(
            1 to listOf(stage("light"), stage("deep"), stage("rem")),
            2 to listOf(stage("light"), stage("deep"), stage("rem")),
            3 to listOf(stage("asleep")),
        )

        val canonical = service.canonicalSleepSessions(rows, stages, metadata)

        assertEquals(listOf(1, 2), canonical.map { it.id })
    }

    @Test
    fun sleepSummariesKeepPairwiseWinnersAcrossBridgeOverlapAndSortByStart() {
        val rows = listOf(
            sleepSummary(1, 2, "2026-04-18T22:00:00Z", "2026-04-19T06:00:00Z", score = 90),
            sleepSummary(2, 2, "2026-04-18T23:00:00Z", "2026-04-19T01:00:00Z", score = 88),
            sleepSummary(3, 1, "2026-04-18T23:30:00Z", "2026-04-19T03:00:00Z", score = 70),
        )

        val canonical = service.canonicalSleepSummaries(rows, metadata)

        assertEquals(listOf(1, 2), canonical.map { it.id })
    }

    @Test
    fun heartRateUsesDensityThenContextPriorityForNearTimestampDuplicates() {
        val rows = listOf(
            HeartRateSampleRow(1, 1, "2026-04-19T02:00:00Z", 60, "sleep"),
            HeartRateSampleRow(2, 2, "2026-04-19T02:00:20Z", 58, "sleep"),
            HeartRateSampleRow(3, 2, "2026-04-19T03:00:00Z", 57, "sleep"),
            HeartRateSampleRow(4, 1, "2026-04-19T12:00:00Z", 80, "general"),
            HeartRateSampleRow(5, 2, "2026-04-19T12:00:10Z", 78, "general"),
        )

        val canonical = service.canonicalHeartRateSamples(rows, metadata)

        assertEquals(listOf(2, 3, 5), canonical.map { it.id })
    }

    @Test
    fun bodyRespiratoryAndHrvResolveSameTimestampCrossSourceConflicts() {
        val body = service.canonicalBodyMeasurements(
            listOf(
                BodyMeasurementRow(1, 1, "2026-04-19T07:00:00Z", "weight", 82.0, "kg"),
                BodyMeasurementRow(2, 2, "2026-04-19T07:00:00Z", "weight", 81.8, "kg"),
                BodyMeasurementRow(3, 1, "2026-04-19T08:00:00Z", "weight", 82.1, "kg"),
            ),
            metadata,
        )
        assertEquals(listOf(2, 3), body.map { it.id })

        val respiratory = service.canonicalRespiratoryRateSamples(
            listOf(
                RespiratoryRateSampleRow(1, 1, "2026-04-19T02:00:00Z", 15, "sleep"),
                RespiratoryRateSampleRow(2, 2, "2026-04-19T02:00:15Z", 14, "sleep"),
            ),
            metadata,
        )
        assertEquals(listOf(2), respiratory.map { it.id })

        val hrv = service.canonicalHrvSamples(
            listOf(
                HrvSampleRow(1, 1, "2026-04-19T02:00:00Z", "rmssd", 40.0, "ms", "sleep"),
                HrvSampleRow(2, 2, "2026-04-19T02:00:20Z", "rmssd", 44.0, "ms", "sleep"),
            ),
            metadata,
        )
        assertEquals(listOf(2), hrv.map { it.id })
    }

    private fun stage(stage: String): SleepStageRow =
        SleepStageRow(
            stage = stage,
            startAt = "2026-04-18T22:00:00Z",
            endAt = "2026-04-18T23:00:00Z",
            durationSeconds = 3600,
        )

    private fun sleepSummary(
        id: Int,
        sourceInstanceId: Int,
        startAt: String,
        endAt: String,
        score: Int,
    ): SleepSummaryRow =
        SleepSummaryRow(
            id = id,
            sourceInstanceId = sourceInstanceId,
            startAt = startAt,
            endAt = endAt,
            timeInBedSeconds = 28800,
            totalSleepSeconds = 25200,
            lightSleepSeconds = null,
            deepSleepSeconds = null,
            remSleepSeconds = null,
            sleepEfficiencyPercent = null,
            sleepLatencySeconds = null,
            wakeupLatencySeconds = null,
            wakeupDurationSeconds = null,
            wakeupCount = null,
            wasoSeconds = null,
            sleepScore = score,
        )
}

package me.aquitano.health.application.metric.steps.derived

import me.aquitano.health.application.CanonicalMetricsPolicy
import me.aquitano.health.application.CanonicalMetricsService
import me.aquitano.health.application.metric.steps.repository.CanonicalStepBucketContributionOutput
import me.aquitano.health.application.metric.steps.repository.CanonicalStepDerivationRepository
import me.aquitano.health.application.metric.steps.repository.CanonicalStepOutput
import me.aquitano.health.application.metric.steps.repository.CanonicalStepSampleOutput
import me.aquitano.health.application.metric.steps.repository.StepSampleRow
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

const val CANONICAL_STEP_ALGORITHM_VERSION = 1

class CanonicalStepDerivationService(
    private val repository: CanonicalStepDerivationRepository,
    private val canonicalMetricsService: CanonicalMetricsService =
        CanonicalMetricsService(CanonicalMetricsPolicy.default()),
) {
    suspend fun recompute(dates: Set<LocalDate>, computedAt: Instant) {
        dates.forEach { date ->
            val dayStart = date.atStartOfDay().toInstant(ZoneOffset.UTC)
            val dayEnd = date.plusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC)
            val rawSamples = repository.listRawSamplesForDay(dayStart, dayEnd)
            val metadata = repository.sourceMetadataFor(rawSamples.map { it.sourceInstanceId }.toSet())
            val canonicalSamples = canonicalMetricsService.canonicalStepSamples(rawSamples, metadata)
            repository.persistCanonicalOutput(
                CanonicalStepOutput(
                    date = date,
                    algorithmVersion = CANONICAL_STEP_ALGORITHM_VERSION,
                    computedAt = computedAt,
                    samples = canonicalSamples.map {
                        CanonicalStepSampleOutput(
                            sampleId = it.id,
                            sourceInstanceId = it.sourceInstanceId,
                            startAt = Instant.parse(it.startAt),
                            endAt = Instant.parse(it.endAt),
                            steps = it.steps,
                        )
                    },
                    bucketContributions = canonicalSamples.flatMap {
                        bucketContributions(date, dayStart, dayEnd, it, computedAt)
                    },
                )
            )
        }
    }

    private fun bucketContributions(
        date: LocalDate,
        dayStart: Instant,
        dayEnd: Instant,
        sample: StepSampleRow,
        computedAt: Instant,
    ): List<CanonicalStepBucketContributionOutput> {
        val sampleStart = Instant.parse(sample.startAt)
        val sampleEnd = Instant.parse(sample.endAt)
        val sampleSeconds = Duration.between(sampleStart, sampleEnd).seconds
        if (sampleSeconds <= 0) return emptyList()

        val contributions = mutableListOf<CanonicalStepBucketContributionOutput>()
        var bucketStart = dayStart
        while (bucketStart.isBefore(dayEnd)) {
            val bucketEnd = minOf(bucketStart.plus(Duration.ofMinutes(15)), dayEnd)
            val overlapSeconds = overlapSeconds(sampleStart, sampleEnd, bucketStart, bucketEnd)
            if (overlapSeconds > 0) {
                contributions += CanonicalStepBucketContributionOutput(
                    date = date,
                    sourceInstanceId = sample.sourceInstanceId,
                    sampleId = sample.id,
                    bucketStartAt = bucketStart,
                    bucketEndAt = bucketEnd,
                    value = sample.steps * (overlapSeconds.toDouble() / sampleSeconds.toDouble()),
                    computedAt = computedAt,
                )
            }
            bucketStart = bucketEnd
        }
        return contributions
    }

    private fun overlapSeconds(
        start: Instant,
        end: Instant,
        windowStart: Instant,
        windowEnd: Instant,
    ): Long {
        val clippedStart = maxOf(start, windowStart)
        val clippedEnd = minOf(end, windowEnd)
        return if (clippedStart.isBefore(clippedEnd)) {
            Duration.between(clippedStart, clippedEnd).seconds
        } else {
            0
        }
    }
}

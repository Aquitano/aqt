package me.aquitano.health.application.metric.steps.derived

import me.aquitano.health.application.CanonicalMetricsPolicy
import me.aquitano.health.application.metric.steps.repository.CanonicalStepBucketContributionOutput
import me.aquitano.health.application.metric.steps.repository.CanonicalStepDerivationRepository
import me.aquitano.health.application.metric.steps.repository.CanonicalStepOutput
import me.aquitano.health.application.metric.steps.repository.CanonicalStepSampleOutput
import me.aquitano.health.application.metric.steps.repository.StepSampleRow
import me.aquitano.health.application.metric.steps.repository.StepDailySummaryRow
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

import me.aquitano.health.application.metric.common.CanonicalIntervalCandidate
import me.aquitano.health.application.metric.common.canonicalIntervalRows

const val CANONICAL_STEP_ALGORITHM_VERSION = 1

class CanonicalStepDerivationService(
    private val repository: CanonicalStepDerivationRepository,
    private val policy: CanonicalMetricsPolicy = CanonicalMetricsPolicy.default(),
) {
    suspend fun recompute(dates: Set<LocalDate>, computedAt: Instant) {
        dates.forEach { date ->
            val dayStart = date.atStartOfDay().toInstant(ZoneOffset.UTC)
            val dayEnd = date.plusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC)
            val rawSamples = repository.listRawSamplesForDay(dayStart, dayEnd)
            val metadata = repository.sourceMetadataFor(rawSamples.map { it.sourceInstanceId }.toSet())
            val preparedSamples = rawSamples.map { preparedCanonicalSample(it, metadata) }
                .sortedWith(compareBy<PreparedCanonicalStepSample> { it.candidate.startAt }
                    .thenBy { it.candidate.endAt }
                    .thenBy { it.candidate.row.id })
            
            val canonicalSamples = canonicalIntervalRows(
                rows = preparedSamples.map { it.asIntervalCandidate() },
                overlaps = { left, right ->
                    left.startAt.isBefore(right.endAt) && right.startAt.isBefore(left.endAt)
                },
                choosePreferred = { left, right ->
                    listOf(left.row, right.row).minWithOrNull(
                        compareBy<PreparedCanonicalStepSample> { it.providerRank }
                            .thenBy { it.durationSeconds }
                            .thenByDescending { it.stepsPerSecond }
                            .thenBy { it.candidate.row.id }
                    )!!.asIntervalCandidate()
                }
            )
            val selectedPreparedSamples = canonicalSamples

            val rawSummaries = repository.listRawDailySummariesForDay(date)
            val summaryMetadata = repository.sourceMetadataFor(rawSummaries.map { it.sourceInstanceId }.toSet())
            val canonicalSummary = canonicalStepDailySummary(rawSummaries, summaryMetadata)
            val dailySummaryOutput = canonicalSummary?.let { summary ->
                me.aquitano.health.application.metric.steps.repository.CanonicalStepDailySummaryOutput(
                    stepDailySummaryId = summary.id,
                    sourceInstanceId = summary.sourceInstanceId,
                    date = date,
                    steps = summary.steps,
                )
            }

            repository.persistCanonicalOutput(
                CanonicalStepOutput(
                    date = date,
                    algorithmVersion = CANONICAL_STEP_ALGORITHM_VERSION,
                    computedAt = computedAt,
                    dailySummary = dailySummaryOutput,
                    samples = selectedPreparedSamples.map {
                        CanonicalStepSampleOutput(
                            sampleId = it.candidate.row.id,
                            sourceInstanceId = it.candidate.row.sourceInstanceId,
                            startAt = it.candidate.startAt,
                            endAt = it.candidate.endAt,
                            steps = it.candidate.row.steps,
                        )
                    },
                    bucketContributions = selectedPreparedSamples.flatMap {
                        bucketContributions(date, dayStart, dayEnd, it, computedAt)
                    },
                )
            )
        }
    }

    fun canonicalStepDailySummary(
        rows: List<StepDailySummaryRow>,
        metadata: Map<Int, SourceMetadata>,
    ): StepDailySummaryRow? =
        rows.minWithOrNull(
            compareBy<StepDailySummaryRow> {
                policy.rank(
                    me.aquitano.health.application.CanonicalMetricFamily.STEPS,
                    metadata[it.sourceInstanceId]?.provider,
                )
            }
                .thenByDescending { it.sampleCount }
                .thenByDescending { it.steps }
                .thenBy { it.sourceInstanceId }
        )

    private fun bucketContributions(
        date: LocalDate,
        dayStart: Instant,
        dayEnd: Instant,
        sample: PreparedCanonicalStepSample,
        computedAt: Instant,
    ): List<CanonicalStepBucketContributionOutput> {
        if (sample.durationSeconds <= 0) return emptyList()

        val contributions = mutableListOf<CanonicalStepBucketContributionOutput>()
        var bucketStart = dayStart
        while (bucketStart.isBefore(dayEnd)) {
            val bucketEnd = minOf(bucketStart.plus(Duration.ofMinutes(15)), dayEnd)
            val overlapSeconds = overlapSeconds(sample.candidate.startAt, sample.candidate.endAt, bucketStart, bucketEnd)
            if (overlapSeconds > 0) {
                contributions += CanonicalStepBucketContributionOutput(
                    date = date,
                    sourceInstanceId = sample.candidate.row.sourceInstanceId,
                    sampleId = sample.candidate.row.id,
                    bucketStartAt = bucketStart,
                    bucketEndAt = bucketEnd,
                    value = sample.candidate.row.steps * (overlapSeconds.toDouble() / sample.durationSeconds.toDouble()),
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

    private fun preparedCanonicalSample(
        row: StepSampleRow,
        metadata: Map<Int, me.aquitano.health.application.metric.common.repository.SourceMetadata>
    ): PreparedCanonicalStepSample {
        val startAt = Instant.parse(row.startAt)
        val endAt = Instant.parse(row.endAt)
        val duration = Duration.between(startAt, endAt).seconds
        return PreparedCanonicalStepSample(
            candidate = CanonicalIntervalCandidate(
                row = row,
                sourceInstanceId = row.sourceInstanceId,
                startAt = startAt,
                endAt = endAt,
            ),
            durationSeconds = duration,
            providerRank = policy.rank(me.aquitano.health.application.CanonicalMetricFamily.STEPS, metadata[row.sourceInstanceId]?.provider),
            stepsPerSecond = row.steps.toDouble() / duration.coerceAtLeast(1).toDouble(),
        )
    }
}

private data class PreparedCanonicalStepSample(
    val candidate: CanonicalIntervalCandidate<StepSampleRow>,
    val durationSeconds: Long,
    val providerRank: Int,
    val stepsPerSecond: Double,
) {
    fun asIntervalCandidate(): CanonicalIntervalCandidate<PreparedCanonicalStepSample> =
        CanonicalIntervalCandidate(
            row = this,
            sourceInstanceId = candidate.sourceInstanceId,
            startAt = candidate.startAt,
            endAt = candidate.endAt,
        )
}

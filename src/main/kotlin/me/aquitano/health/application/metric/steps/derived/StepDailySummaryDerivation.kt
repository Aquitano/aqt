package me.aquitano.health.application.metric.steps.derived

import me.aquitano.health.application.metric.common.DerivationJob
import me.aquitano.health.application.metric.common.MetricDerivationCalculator
import me.aquitano.health.application.metric.common.MetricDerivationInput
import me.aquitano.health.application.metric.common.MetricDerivedBuilder
import me.aquitano.health.application.metric.common.MetricDerivedOutput
import me.aquitano.health.application.metric.common.MetricDerivedOutputWriter
import me.aquitano.health.application.metric.common.MetricInputLoader
import me.aquitano.health.application.metric.steps.repository.StepDailySummaryDerivationRepository
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.math.roundToInt

private const val STEP_DAILY_SUMMARY_ALGORITHM_VERSION = 1

class StepDailySummaryDerivation(
    private val repository: StepDailySummaryDerivationRepository,
) {
    suspend fun recompute(
        sourceInstanceId: Int,
        dates: Set<LocalDate>,
        computedAt: Instant,
    ) {
        dates.forEach { date ->
            builder(sourceInstanceId).processJob(
                DerivationJob.forDate(date, ZoneOffset.UTC, STEP_DAILY_SUMMARY_ALGORITHM_VERSION),
                computedAt,
            )
        }
    }

    private fun builder(
        sourceInstanceId: Int,
    ): MetricDerivedBuilder<StepDailySummaryInput, StepDailySummaryOutput> =
        MetricDerivedBuilder(
            inputLoader = StepDailySummaryInputLoader(
                sourceInstanceId = sourceInstanceId,
                repository = repository,
            ),
            calculator = StepDailySummaryCalculator(),
            outputWriter = StepDailySummaryOutputWriter(repository),
        )
}

private class StepDailySummaryInputLoader(
    private val sourceInstanceId: Int,
    private val repository: StepDailySummaryDerivationRepository,
) : MetricInputLoader<StepDailySummaryInput> {
    override suspend fun loadInput(
        range: ClosedRange<Instant>,
        timezone: ZoneId,
        computedAt: Instant,
    ): StepDailySummaryInput {
        val date = LocalDate.ofInstant(range.start, timezone)
        return StepDailySummaryInput(
            sourceInstanceId = sourceInstanceId,
            date = date,
            timezone = timezone,
            computedAt = computedAt,
            dayStart = range.start,
            dayEnd = range.endInclusive,
            samples = repository.listStepSamplesOverlapping(
                sourceInstanceId = sourceInstanceId,
                dayStart = range.start,
                dayEnd = range.endInclusive,
            ),
        )
    }
}

data class StepDailySummaryInput(
    val sourceInstanceId: Int,
    override val date: LocalDate,
    override val timezone: ZoneId,
    val computedAt: Instant,
    val dayStart: Instant,
    val dayEnd: Instant,
    val samples: List<StepDailySummaryRawSample>,
) : MetricDerivationInput

data class StepDailySummaryRawSample(
    val startAt: Instant,
    val endAt: Instant,
    val steps: Int,
)

private class StepDailySummaryCalculator :
    MetricDerivationCalculator<StepDailySummaryInput, StepDailySummaryOutput> {
    override fun derive(input: StepDailySummaryInput): StepDailySummaryOutput =
        StepDailySummaryOutput(
            sourceInstanceId = input.sourceInstanceId,
            date = input.date,
            timezone = input.timezone,
            algorithmVersion = STEP_DAILY_SUMMARY_ALGORITHM_VERSION,
            computedAt = input.computedAt,
            steps = input.samples.sumOf {
                allocatedStepsForDay(it, input.dayStart, input.dayEnd)
            },
            sampleCount = input.samples.size,
        )

    private fun allocatedStepsForDay(
        sample: StepDailySummaryRawSample,
        dayStart: Instant,
        dayEnd: Instant,
    ): Int {
        val totalSeconds = Duration.between(sample.startAt, sample.endAt).seconds
        if (totalSeconds <= 0) return 0

        val overlapStart = maxOf(sample.startAt, dayStart)
        val overlapEnd = minOf(sample.endAt, dayEnd)
        val overlapSeconds = Duration.between(overlapStart, overlapEnd).seconds
        if (overlapSeconds <= 0) return 0

        return (sample.steps.toDouble() * overlapSeconds / totalSeconds).roundToInt()
    }
}

data class StepDailySummaryOutput(
    val sourceInstanceId: Int,
    override val date: LocalDate,
    override val timezone: ZoneId,
    override val algorithmVersion: Int,
    val computedAt: Instant,
    val steps: Int,
    val sampleCount: Int,
) : MetricDerivedOutput

private class StepDailySummaryOutputWriter(
    private val repository: StepDailySummaryDerivationRepository,
) : MetricDerivedOutputWriter<StepDailySummaryOutput> {
    override suspend fun persistOutput(output: StepDailySummaryOutput): Int =
        repository.upsertStepDailySummary(output)
}

package me.aquitano.health.application.metric.heart.derived

import me.aquitano.health.application.CanonicalMetricsPolicy
import me.aquitano.health.application.metric.common.canonicalTimestampRows
import me.aquitano.health.application.metric.common.DerivationJobInput
import me.aquitano.health.application.metric.common.DerivedRebuildReason
import me.aquitano.health.application.metric.common.MetricDerivationCalculator
import me.aquitano.health.application.metric.common.MetricDerivationInput
import me.aquitano.health.application.metric.common.MetricDerivedBuilder
import me.aquitano.health.application.metric.common.MetricDerivedOutput
import me.aquitano.health.application.metric.common.MetricDerivedOutputWriter
import me.aquitano.health.application.metric.common.MetricInputLoader
import me.aquitano.health.application.metric.heart.repository.CanonicalHeartRateDerivationRepository
import me.aquitano.health.application.metric.heart.repository.HeartRateSampleRow
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

const val CANONICAL_HEART_RATE_ALGORITHM_VERSION = 1

class CanonicalHeartRateDerivationService(
    private val repository: CanonicalHeartRateDerivationRepository,
    private val policy: CanonicalMetricsPolicy = CanonicalMetricsPolicy.default(),
) {
    suspend fun recompute(dates: Set<LocalDate>, computedAt: Instant) {
        dates.forEach { date ->
            builder(Clock.fixed(computedAt, ZoneOffset.UTC)).processJob(
                CanonicalHeartRateJob(date, computedAt, computedAt)
            )
        }
    }

    private fun builder(clock: Clock): MetricDerivedBuilder<CanonicalHeartRateInput, CanonicalHeartRateOutput> =
        MetricDerivedBuilder(
            inputLoader = CanonicalHeartRateInputLoader(repository),
            calculator = CanonicalHeartRateCalculator(repository, policy),
            outputWriter = CanonicalHeartRateOutputWriter(repository),
            clock = clock,
        )
}

private data class CanonicalHeartRateJob(
    private val date: LocalDate,
    override val createdAt: Instant,
    override val updatedAt: Instant,
) : DerivationJobInput {
    override val range: ClosedRange<Instant> =
        date.atStartOfDay().toInstant(ZoneOffset.UTC)..date.plusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC)
    override val timezone: ZoneId = ZoneOffset.UTC
    override val algorithmVersion: Int = CANONICAL_HEART_RATE_ALGORITHM_VERSION
    override val reason: DerivedRebuildReason = DerivedRebuildReason.INGESTION
    override val attemptCount: Int = 0
    override val lastError: String? = null
    override val lockedAt: Instant? = null
}

private class CanonicalHeartRateInputLoader(
    private val repository: CanonicalHeartRateDerivationRepository,
) : MetricInputLoader<CanonicalHeartRateInput> {
    override suspend fun loadInput(
        range: ClosedRange<Instant>,
        timezone: ZoneId,
        computedAt: Instant,
    ): CanonicalHeartRateInput =
        CanonicalHeartRateInput(
            date = LocalDate.ofInstant(range.start, timezone),
            timezone = timezone,
            computedAt = computedAt,
            samples = repository.listRawSamplesForDay(range.start, range.endInclusive),
        )
}

data class CanonicalHeartRateInput(
    override val date: LocalDate,
    override val timezone: ZoneId,
    val computedAt: Instant,
    val samples: List<HeartRateSampleRow>,
) : MetricDerivationInput

data class CanonicalHeartRateSampleOutput(
    val sampleId: Int,
    val sourceInstanceId: Int,
    val measuredAt: Instant,
    val context: String,
)

data class CanonicalHeartRateOutput(
    override val date: LocalDate,
    override val timezone: ZoneId,
    override val algorithmVersion: Int,
    val computedAt: Instant,
    val samples: List<CanonicalHeartRateSampleOutput>,
) : MetricDerivedOutput

private class CanonicalHeartRateCalculator(
    private val repository: CanonicalHeartRateDerivationRepository,
    private val policy: CanonicalMetricsPolicy,
) : MetricDerivationCalculator<CanonicalHeartRateInput, CanonicalHeartRateOutput> {
    override fun derive(input: CanonicalHeartRateInput): CanonicalHeartRateOutput {
        val metadata = repository.sourceMetadataFor(input.samples.map { it.sourceInstanceId }.toSet())
        val densityBySource = input.samples.groupingBy { it.sourceInstanceId }.eachCount()
        val canonical = canonicalTimestampRows(
            rows = input.samples,
            measuredAt = { Instant.parse(it.measuredAt) },
            groupKey = { it.context },
            sourceInstanceId = { it.sourceInstanceId },
            choosePreferred = { candidates ->
                candidates.maxWithOrNull(
                    compareBy<HeartRateSampleRow> { densityBySource[it.sourceInstanceId] ?: 0 }
                        .thenBy { -policy.heartRateRank(metadata[it.sourceInstanceId]?.provider, it.context) }
                        .thenBy { -it.id }
                )!!
            },
        )
        return CanonicalHeartRateOutput(
            date = input.date,
            timezone = input.timezone,
            algorithmVersion = CANONICAL_HEART_RATE_ALGORITHM_VERSION,
            computedAt = input.computedAt,
            samples = canonical.map {
                CanonicalHeartRateSampleOutput(
                    sampleId = it.id,
                    sourceInstanceId = it.sourceInstanceId,
                    measuredAt = Instant.parse(it.measuredAt),
                    context = it.context,
                )
            },
        )
    }
}

private class CanonicalHeartRateOutputWriter(
    private val repository: CanonicalHeartRateDerivationRepository,
) : MetricDerivedOutputWriter<CanonicalHeartRateOutput> {
    override suspend fun persistOutput(output: CanonicalHeartRateOutput): Int =
        repository.persistCanonicalSamples(output)
}

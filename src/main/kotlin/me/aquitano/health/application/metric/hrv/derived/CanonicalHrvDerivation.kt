package me.aquitano.health.application.metric.hrv.derived

import me.aquitano.health.application.CanonicalMetricsPolicy
import me.aquitano.health.application.CanonicalMetricFamily
import me.aquitano.health.application.metric.common.DerivationJobInput
import me.aquitano.health.application.metric.common.DerivedRebuildReason
import me.aquitano.health.application.metric.common.MetricDerivationCalculator
import me.aquitano.health.application.metric.common.MetricDerivationInput
import me.aquitano.health.application.metric.common.MetricDerivedBuilder
import me.aquitano.health.application.metric.common.MetricDerivedOutput
import me.aquitano.health.application.metric.common.MetricDerivedOutputWriter
import me.aquitano.health.application.metric.common.MetricInputLoader
import me.aquitano.health.application.metric.common.canonicalTimestampRows
import me.aquitano.health.application.metric.hrv.repository.CanonicalHrvDerivationRepository
import me.aquitano.health.application.metric.hrv.repository.HrvSampleRow
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

const val CANONICAL_HRV_ALGORITHM_VERSION = 1

class CanonicalHrvDerivationService(
    private val repository: CanonicalHrvDerivationRepository,
    private val policy: CanonicalMetricsPolicy = CanonicalMetricsPolicy.default(),
) {
    suspend fun recompute(dates: Set<LocalDate>, computedAt: Instant) {
        dates.forEach { date ->
            builder(Clock.fixed(computedAt, ZoneOffset.UTC)).processJob(
                CanonicalHrvJob(date, computedAt, computedAt)
            )
        }
    }

    private fun builder(clock: Clock): MetricDerivedBuilder<CanonicalHrvInput, CanonicalHrvOutput> =
        MetricDerivedBuilder(
            inputLoader = CanonicalHrvInputLoader(repository),
            calculator = CanonicalHrvCalculator(repository, policy),
            outputWriter = CanonicalHrvOutputWriter(repository),
            clock = clock,
        )
}

private data class CanonicalHrvJob(
    private val date: LocalDate,
    override val createdAt: Instant,
    override val updatedAt: Instant,
) : DerivationJobInput {
    override val range: ClosedRange<Instant> =
        date.atStartOfDay().toInstant(ZoneOffset.UTC)..date.plusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC)
    override val timezone: ZoneId = ZoneOffset.UTC
    override val algorithmVersion: Int = CANONICAL_HRV_ALGORITHM_VERSION
    override val reason: DerivedRebuildReason = DerivedRebuildReason.INGESTION
    override val attemptCount: Int = 0
    override val lastError: String? = null
    override val lockedAt: Instant? = null
}

private class CanonicalHrvInputLoader(
    private val repository: CanonicalHrvDerivationRepository,
) : MetricInputLoader<CanonicalHrvInput> {
    override suspend fun loadInput(
        range: ClosedRange<Instant>,
        timezone: ZoneId,
        computedAt: Instant,
    ): CanonicalHrvInput =
        CanonicalHrvInput(
            date = LocalDate.ofInstant(range.start, timezone),
            timezone = timezone,
            computedAt = computedAt,
            samples = repository.listRawSamplesForDay(range.start, range.endInclusive),
        )
}

data class CanonicalHrvInput(
    override val date: LocalDate,
    override val timezone: ZoneId,
    val computedAt: Instant,
    val samples: List<HrvSampleRow>,
) : MetricDerivationInput

data class CanonicalHrvSampleOutput(
    val sampleId: Int,
    val sourceInstanceId: Int,
    val measuredAt: Instant,
    val metricType: String,
    val context: String,
)

data class CanonicalHrvOutput(
    override val date: LocalDate,
    override val timezone: ZoneId,
    override val algorithmVersion: Int,
    val computedAt: Instant,
    val samples: List<CanonicalHrvSampleOutput>,
) : MetricDerivedOutput

private class CanonicalHrvCalculator(
    private val repository: CanonicalHrvDerivationRepository,
    private val policy: CanonicalMetricsPolicy,
) : MetricDerivationCalculator<CanonicalHrvInput, CanonicalHrvOutput> {
    override fun derive(input: CanonicalHrvInput): CanonicalHrvOutput {
        val metadata = repository.sourceMetadataFor(input.samples.map { it.sourceInstanceId }.toSet())
        val canonical = canonicalTimestampRows(
            rows = input.samples,
            measuredAt = { Instant.parse(it.measuredAt) },
            groupKey = { it.metricType to it.context },
            sourceInstanceId = { it.sourceInstanceId },
            choosePreferred = { candidates ->
                candidates.minWithOrNull(
                    compareBy<HrvSampleRow> {
                        policy.rank(CanonicalMetricFamily.HRV, metadata[it.sourceInstanceId]?.provider)
                    }.thenBy { it.id }
                )!!
            },
        )
        return CanonicalHrvOutput(
            date = input.date,
            timezone = input.timezone,
            algorithmVersion = CANONICAL_HRV_ALGORITHM_VERSION,
            computedAt = input.computedAt,
            samples = canonical.map {
                CanonicalHrvSampleOutput(
                    sampleId = it.id,
                    sourceInstanceId = it.sourceInstanceId,
                    measuredAt = Instant.parse(it.measuredAt),
                    metricType = it.metricType,
                    context = it.context,
                )
            },
        )
    }
}

private class CanonicalHrvOutputWriter(
    private val repository: CanonicalHrvDerivationRepository,
) : MetricDerivedOutputWriter<CanonicalHrvOutput> {
    override suspend fun persistOutput(output: CanonicalHrvOutput): Int =
        repository.persistCanonicalSamples(output)
}

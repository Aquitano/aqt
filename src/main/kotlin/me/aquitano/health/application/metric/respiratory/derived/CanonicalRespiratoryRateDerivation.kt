package me.aquitano.health.application.metric.respiratory.derived

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
import me.aquitano.health.application.metric.respiratory.repository.CanonicalRespiratoryRateDerivationRepository
import me.aquitano.health.application.metric.respiratory.repository.RespiratoryRateSampleRow
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

const val CANONICAL_RESPIRATORY_RATE_ALGORITHM_VERSION = 1

class CanonicalRespiratoryRateDerivationService(
    private val repository: CanonicalRespiratoryRateDerivationRepository,
    private val policy: CanonicalMetricsPolicy = CanonicalMetricsPolicy.default(),
) {
    suspend fun recompute(dates: Set<LocalDate>, computedAt: Instant) {
        dates.forEach { date ->
            builder(Clock.fixed(computedAt, ZoneOffset.UTC)).processJob(
                CanonicalRespiratoryRateJob(date, computedAt, computedAt)
            )
        }
    }

    private fun builder(clock: Clock): MetricDerivedBuilder<CanonicalRespiratoryRateInput, CanonicalRespiratoryRateOutput> =
        MetricDerivedBuilder(
            inputLoader = CanonicalRespiratoryRateInputLoader(repository),
            calculator = CanonicalRespiratoryRateCalculator(repository, policy),
            outputWriter = CanonicalRespiratoryRateOutputWriter(repository),
            clock = clock,
        )
}

private data class CanonicalRespiratoryRateJob(
    private val date: LocalDate,
    override val createdAt: Instant,
    override val updatedAt: Instant,
) : DerivationJobInput {
    override val range: ClosedRange<Instant> =
        date.atStartOfDay().toInstant(ZoneOffset.UTC)..date.plusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC)
    override val timezone: ZoneId = ZoneOffset.UTC
    override val algorithmVersion: Int = CANONICAL_RESPIRATORY_RATE_ALGORITHM_VERSION
    override val reason: DerivedRebuildReason = DerivedRebuildReason.INGESTION
    override val attemptCount: Int = 0
    override val lastError: String? = null
    override val lockedAt: Instant? = null
}

private class CanonicalRespiratoryRateInputLoader(
    private val repository: CanonicalRespiratoryRateDerivationRepository,
) : MetricInputLoader<CanonicalRespiratoryRateInput> {
    override suspend fun loadInput(
        range: ClosedRange<Instant>,
        timezone: ZoneId,
        computedAt: Instant,
    ): CanonicalRespiratoryRateInput =
        CanonicalRespiratoryRateInput(
            date = LocalDate.ofInstant(range.start, timezone),
            timezone = timezone,
            computedAt = computedAt,
            samples = repository.listRawSamplesForDay(range.start, range.endInclusive),
        )
}

data class CanonicalRespiratoryRateInput(
    override val date: LocalDate,
    override val timezone: ZoneId,
    val computedAt: Instant,
    val samples: List<RespiratoryRateSampleRow>,
) : MetricDerivationInput

data class CanonicalRespiratoryRateSampleOutput(
    val sampleId: Int,
    val sourceInstanceId: Int,
    val measuredAt: Instant,
    val context: String,
)

data class CanonicalRespiratoryRateOutput(
    override val date: LocalDate,
    override val timezone: ZoneId,
    override val algorithmVersion: Int,
    val computedAt: Instant,
    val samples: List<CanonicalRespiratoryRateSampleOutput>,
) : MetricDerivedOutput

private class CanonicalRespiratoryRateCalculator(
    private val repository: CanonicalRespiratoryRateDerivationRepository,
    private val policy: CanonicalMetricsPolicy,
) : MetricDerivationCalculator<CanonicalRespiratoryRateInput, CanonicalRespiratoryRateOutput> {
    override fun derive(input: CanonicalRespiratoryRateInput): CanonicalRespiratoryRateOutput {
        val metadata = repository.sourceMetadataFor(input.samples.map { it.sourceInstanceId }.toSet())
        val canonical = canonicalTimestampRows(
            rows = input.samples,
            measuredAt = { it.measuredAt },
            groupKey = { it.context },
            sourceInstanceId = { it.sourceInstanceId },
            choosePreferred = { candidates ->
                candidates.minWithOrNull(
                    compareBy<RespiratoryRateSampleRow> {
                        policy.rank(CanonicalMetricFamily.RESPIRATORY_RATE, metadata[it.sourceInstanceId]?.provider)
                    }.thenBy { it.id }
                )!!
            },
        )
        return CanonicalRespiratoryRateOutput(
            date = input.date,
            timezone = input.timezone,
            algorithmVersion = CANONICAL_RESPIRATORY_RATE_ALGORITHM_VERSION,
            computedAt = input.computedAt,
            samples = canonical.map {
                CanonicalRespiratoryRateSampleOutput(
                    sampleId = it.id,
                    sourceInstanceId = it.sourceInstanceId,
                    measuredAt = it.measuredAt,
                    context = it.context,
                )
            },
        )
    }
}

private class CanonicalRespiratoryRateOutputWriter(
    private val repository: CanonicalRespiratoryRateDerivationRepository,
) : MetricDerivedOutputWriter<CanonicalRespiratoryRateOutput> {
    override suspend fun persistOutput(output: CanonicalRespiratoryRateOutput): Int =
        repository.persistCanonicalSamples(output)
}

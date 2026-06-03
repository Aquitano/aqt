package me.aquitano.health.application.metric.sleep.derived

import me.aquitano.health.application.metric.common.DerivationJobInput
import me.aquitano.health.application.metric.common.DerivedRebuildReason
import me.aquitano.health.application.metric.common.MetricDerivationCalculator
import me.aquitano.health.application.metric.common.MetricDerivationInput
import me.aquitano.health.application.metric.common.MetricDerivedBuilder
import me.aquitano.health.application.metric.common.MetricDerivedOutput
import me.aquitano.health.application.metric.common.MetricDerivedOutputWriter
import me.aquitano.health.application.metric.common.MetricInputLoader
import me.aquitano.health.application.metric.sleep.repository.SleepNightDerivationRepository
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

const val SLEEP_NIGHT_ALGORITHM_VERSION = 1
const val CANONICAL_SLEEP_NIGHT_ALGORITHM_VERSION = 1

class SleepNightDerivation(
    private val repository: SleepNightDerivationRepository,
) {
    suspend fun recompute(
        sourceInstanceIds: Set<Int>?,
        dates: Set<LocalDate>,
        timezone: ZoneId,
        computedAt: Instant,
    ) {
        dates.forEach { date ->
            MetricDerivedBuilder(
                inputLoader = SleepNightInputLoader(
                    sourceInstanceIds = sourceInstanceIds,
                    date = date,
                    repository = repository,
                ),
                calculator = SleepNightCalculator(),
                outputWriter = SleepNightOutputWriter(repository),
                clock = Clock.fixed(computedAt, timezone),
            ).processJob(
                SleepNightJob(
                    date = date,
                    timezone = timezone,
                    createdAt = computedAt,
                    updatedAt = computedAt,
                )
            )
        }
    }
}

private data class SleepNightJob(
    private val date: LocalDate,
    override val timezone: ZoneId,
    override val createdAt: Instant,
    override val updatedAt: Instant,
) : DerivationJobInput {
    override val range: ClosedRange<Instant> =
        date.atStartOfDay(timezone).toInstant()..date.plusDays(1)
            .atStartOfDay(timezone)
            .toInstant()
    override val algorithmVersion: Int = SLEEP_NIGHT_ALGORITHM_VERSION
    override val reason: DerivedRebuildReason = DerivedRebuildReason.INGESTION
    override val attemptCount: Int = 0
    override val lastError: String? = null
    override val lockedAt: Instant? = null
}

private class SleepNightInputLoader(
    private val sourceInstanceIds: Set<Int>?,
    private val date: LocalDate,
    private val repository: SleepNightDerivationRepository,
) : MetricInputLoader<SleepNightInput> {
    override suspend fun loadInput(
        range: ClosedRange<Instant>,
        timezone: ZoneId,
        computedAt: Instant,
    ): SleepNightInput =
        SleepNightInput(
            date = date,
            timezone = timezone,
            computedAt = computedAt,
            sourceInstanceIds = sourceInstanceIds,
            sessions = repository.listSleepSessionsEndingInWindow(
                sourceInstanceIds = sourceInstanceIds,
                windowStart = range.start,
                windowEnd = range.endInclusive,
            ),
        )
}

data class SleepNightInput(
    override val date: LocalDate,
    override val timezone: ZoneId,
    val computedAt: Instant,
    val sourceInstanceIds: Set<Int>?,
    val sessions: List<SleepNightRawSession>,
) : MetricDerivationInput

data class SleepNightRawSession(
    val id: Int,
    val sourceInstanceId: Int,
    val endAt: Instant,
)

private class SleepNightCalculator :
    MetricDerivationCalculator<SleepNightInput, SleepNightOutput> {
    override fun derive(input: SleepNightInput): SleepNightOutput =
        SleepNightOutput(
            date = input.date,
            timezone = input.timezone,
            algorithmVersion = SLEEP_NIGHT_ALGORITHM_VERSION,
            computedAt = input.computedAt,
            sourceInstanceIds = input.sourceInstanceIds,
            nights = input.sessions.map {
                SleepNightDerivedRow(
                    sourceInstanceId = it.sourceInstanceId,
                    sleepSessionId = it.id,
                )
            },
        )
}

data class SleepNightOutput(
    override val date: LocalDate,
    override val timezone: ZoneId,
    override val algorithmVersion: Int,
    val computedAt: Instant,
    val sourceInstanceIds: Set<Int>?,
    val nights: List<SleepNightDerivedRow>,
) : MetricDerivedOutput

data class SleepNightDerivedRow(
    val sourceInstanceId: Int,
    val sleepSessionId: Int,
)

private class SleepNightOutputWriter(
    private val repository: SleepNightDerivationRepository,
) : MetricDerivedOutputWriter<SleepNightOutput> {
    override suspend fun persistOutput(output: SleepNightOutput): Int =
        repository.replaceSleepNights(output)
}

package me.aquitano.health.application.metric.common

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * Generic pipeline for deriving metric data from raw inputs.
 *
 * The pipeline follows three stages:
 * 1. **Load** — [MetricInputLoader] fetches the raw input needed for a job.
 * 2. **Calculate** — [MetricDerivationCalculator] transforms the input into
 *    derived output.
 * 3. **Persist** — [MetricDerivedOutputWriter] stores the derived output.
 *
 * @param I The concrete input type produced by the loader.
 * @param O The concrete output type produced by the calculator and consumed by
 *   the writer.
 */
class MetricDerivedBuilder<I : MetricDerivationInput, O : MetricDerivedOutput>(
    private val inputLoader: MetricInputLoader<I>,
    private val calculator: MetricDerivationCalculator<I, O>,
    private val outputWriter: MetricDerivedOutputWriter<O>,
) {

    /**
     * Executes a single derivation [job] stamped with [computedAt].
     *
     * Returns a [DerivedRebuildResult] describing the work performed. Failures
     * in any stage are propagated as exceptions so that callers can apply
     * back-off and retry logic.
     */
    suspend fun processJob(job: DerivationJob, computedAt: Instant): DerivedRebuildResult {
        val input = inputLoader.loadInput(
            range = job.range,
            timezone = job.timezone,
            computedAt = computedAt,
        )

        val output = calculator.derive(input)

        val rowsWritten = outputWriter.persistOutput(output)

        return DerivedRebuildResult(
            range = job.range,
            timezone = job.timezone,
            algorithmVersion = job.algorithmVersion,
            derivedRowsWritten = rowsWritten,
        )
    }
}

/**
 * Describes a request to rebuild derived metric data for a specific time range.
 */
data class DerivationJob(
    /** Time range the derivation covers. */
    val range: ClosedRange<Instant>,
    /** Target timezone for date-based grouping. */
    val timezone: ZoneId,
    /** Version of the derivation algorithm; bumps force re-derivation. */
    val algorithmVersion: Int,
) {
    companion object {
        /** The derivation job covering one local [date] in [timezone]. */
        fun forDate(date: LocalDate, timezone: ZoneId, algorithmVersion: Int): DerivationJob =
            DerivationJob(
                range = date.atStartOfDay(timezone).toInstant()..
                        date.plusDays(1).atStartOfDay(timezone).toInstant(),
                timezone = timezone,
                algorithmVersion = algorithmVersion,
            )
    }
}

/**
 * Result of running a single derivation job.
 */
data class DerivedRebuildResult(
    /** Time range that was derived. */
    val range: ClosedRange<Instant>,
    /** Timezone used for the derivation. */
    val timezone: ZoneId,
    /** Algorithm version that was applied. */
    val algorithmVersion: Int,
    /** Number of derived rows written. */
    val derivedRowsWritten: Int,
)

/** Loads raw input for a metric derivation. */
fun interface MetricInputLoader<I : MetricDerivationInput> {
    /**
     * Fetches input data for the given [range] and [timezone].
     *
     * @param range The time range to load data for.
     * @param timezone The target timezone for date-based calculations.
     * @param computedAt The instant the derivation started; useful for
     *   freshness checks or filtering out data ingested after derivation began.
     */
    suspend fun loadInput(
        range: ClosedRange<Instant>,
        timezone: ZoneId,
        computedAt: Instant,
    ): I
}

/** Base interface for metric derivation inputs. */
interface MetricDerivationInput {
    /** The calendar date this input represents. */
    val date: LocalDate
    /** The timezone used for date boundaries. */
    val timezone: ZoneId
}

/** Transforms raw [I] into derived [O]. */
fun interface MetricDerivationCalculator<I : MetricDerivationInput, O : MetricDerivedOutput> {
    fun derive(input: I): O
}

/** Base interface for derived metric outputs. */
interface MetricDerivedOutput {
    /** The calendar date this output represents. */
    val date: LocalDate
    /** The timezone used for date boundaries. */
    val timezone: ZoneId
    /** Algorithm version that produced this output. */
    val algorithmVersion: Int
}

/** Persists derived metric [O] and returns the number of rows written. */
fun interface MetricDerivedOutputWriter<O : MetricDerivedOutput> {
    suspend fun persistOutput(output: O): Int
}

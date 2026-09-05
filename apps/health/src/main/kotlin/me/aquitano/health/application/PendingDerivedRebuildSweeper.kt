package me.aquitano.health.application

import io.github.oshai.kotlinlogging.KotlinLogging
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import me.aquitano.health.infrastructure.logging.*
import me.aquitano.health.infrastructure.repositories.PendingDerivedRebuildRepository
import me.aquitano.health.infrastructure.time.UtcClock
import java.time.Duration
import java.time.Instant
import kotlin.math.min
import kotlin.math.pow

private val sweeperLogger = KotlinLogging.logger {}

object PendingDerivedRebuildPolicy {
    /** Exponential backoff in minutes (1, 2, 4, ...) capped at one hour. */
    fun nextAttemptAfterFailure(now: Instant, attempts: Int): Instant {
        val exponent = (attempts - 1).coerceAtLeast(0)
        val minutes = min(60.0, 2.0.pow(exponent)).toLong()
        return now.plus(Duration.ofMinutes(minutes))
    }
}

/**
 * Retries derived rebuilds that failed after their ingestion batch committed, so
 * projections converge without an operator noticing the staleness and running a
 * manual replay. Rows are queued by [IngestionService] and dropped once rebuilt.
 */
class PendingDerivedRebuildSweeper(
    private val repository: PendingDerivedRebuildRepository,
    private val derivedRebuildExecutor: DerivedRebuildExecutor,
    private val clock: UtcClock,
    private val pollInterval: Duration = Duration.ofMinutes(1),
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var job: Job? = null

    fun start() {
        if (job != null) return
        job = scope.launch {
            while (isActive) {
                try {
                    sweep(clock.now())
                } catch (exception: CancellationException) {
                    throw exception
                } catch (exception: Exception) {
                    sweeperLogger.error(exception) { "pending_derived_rebuild_sweep_failed" }
                }
                delay(pollInterval.toMillis())
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        scope.cancel()
    }

    /** Returns the number of queued rows successfully rebuilt in this pass. */
    suspend fun sweep(now: Instant, limit: Int = DEFAULT_SWEEP_LIMIT): Int {
        val due = repository.due(now, limit)
        if (due.isEmpty()) return 0
        var rebuilt = 0
        due.groupBy { it.sourceInstanceId }.forEach { (sourceInstanceId, rows) ->
            val request = DerivedRebuildRequest(
                sourceInstanceId = sourceInstanceId,
                affectedDates = rows
                    .groupBy({ it.derivedKind }, { it.affectedDate })
                    .mapValues { it.value.toSet() },
            )
            try {
                derivedRebuildExecutor.rebuild(request, clock.now())
                repository.deleteCompleted(rows.map { it.id })
                rebuilt += rows.size
                sweeperLogger.infoWithContext(
                    "pending_derived_rebuild_repaired",
                    "sourceInstanceId" to sourceInstanceId,
                    "dateCount" to rows.size,
                )
            } catch (exception: Exception) {
                if (exception is CancellationException) throw exception
                repository.markAttemptFailed(
                    ids = rows.map { it.id },
                    nextAttemptAt = { attempts ->
                        PendingDerivedRebuildPolicy.nextAttemptAfterFailure(now, attempts)
                    },
                    error = exception.message ?: "Derived rebuild failed",
                    now = now,
                )
                sweeperLogger.warnWithContext(
                    "pending_derived_rebuild_retry_failed",
                    "sourceInstanceId" to sourceInstanceId,
                    "dateCount" to rows.size,
                    "maxAttempts" to (rows.maxOf { it.attempts } + 1),
                    throwable = exception,
                )
            }
        }
        return rebuilt
    }
}

private const val DEFAULT_SWEEP_LIMIT = 200

package me.aquitano.health.application

import kotlinx.coroutines.runBlocking
import me.aquitano.health.domain.DerivedKind
import me.aquitano.health.infrastructure.database.DatabaseFactory
import me.aquitano.health.infrastructure.database.suspendDbTransaction
import me.aquitano.health.infrastructure.repositories.PendingDerivedRebuildRepository
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.infrastructure.time.UtcClock
import me.aquitano.health.test.PostgresTestDatabase
import java.time.Instant
import java.time.LocalDate
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals

class PendingDerivedRebuildSweeperTest {
    @Test
    fun retriesQueuedRebuildWithBackoffUntilItSucceeds() = runBlocking {
        val database = DatabaseFactory().initialize(PostgresTestDatabase.config())
        val repository = PendingDerivedRebuildRepository(database)
        val supportRepository = SupportRepository(database)
        val executor = FlakyDerivedRebuildExecutor(failuresBeforeSuccess = 1)
        val sweeper = PendingDerivedRebuildSweeper(
            repository = repository,
            derivedRebuildExecutor = executor,
            clock = UtcClock(),
        )
        val now = Instant.parse("2026-06-01T10:00:00Z")
        val date = LocalDate.parse("2026-05-31")

        val sourceInstanceId = suspendDbTransaction(db = database) {
            val sourceInstance = supportRepository.resolveOrCreateSourceInstanceInTransaction(
                provider = "health_connect",
                providerInstanceId = "pixel-8-health-connect",
                now = now,
            )
            repository.enqueueInTransaction(
                DerivedRebuildRequest(
                    sourceInstanceId = sourceInstance.id,
                    affectedDates = mapOf(DerivedKind.STEP_SUMMARY to setOf(date)),
                ),
                error = "initial rebuild failure",
                now = now,
            )
            sourceInstance.id
        }

        // First sweep: the executor still fails, so the row stays queued with backoff.
        assertEquals(0, sweeper.sweep(now))
        assertEquals(1, executor.calls.get())
        assertEquals(0, repository.due(now, limit = 10).size)

        // Not due again until the backoff window has elapsed.
        val afterBackoff = PendingDerivedRebuildPolicy.nextAttemptAfterFailure(now, attempts = 1)
        val due = repository.due(afterBackoff, limit = 10)
        assertEquals(1, due.size)
        assertEquals(sourceInstanceId, due.single().sourceInstanceId)
        assertEquals(1, due.single().attempts)
        assertEquals("flaky rebuild failure", due.single().lastErrorMessage)

        // Second sweep succeeds and clears the queue.
        assertEquals(1, sweeper.sweep(afterBackoff))
        assertEquals(2, executor.calls.get())
        assertEquals(0, repository.due(afterBackoff.plusSeconds(3_600), limit = 10).size)
        assertEquals(
            mapOf(DerivedKind.STEP_SUMMARY to setOf(date)),
            executor.lastRequest?.affectedDates,
        )
    }

    private class FlakyDerivedRebuildExecutor(
        private val failuresBeforeSuccess: Int,
    ) : DerivedRebuildExecutor {
        val calls = AtomicInteger(0)
        var lastRequest: DerivedRebuildRequest? = null

        override suspend fun rebuild(request: DerivedRebuildRequest, computedAt: Instant) {
            lastRequest = request
            if (calls.incrementAndGet() <= failuresBeforeSuccess) {
                throw IllegalStateException("flaky rebuild failure")
            }
        }
    }
}

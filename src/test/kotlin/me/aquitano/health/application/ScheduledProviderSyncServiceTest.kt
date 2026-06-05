package me.aquitano.health.application

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import me.aquitano.health.domain.ConflictException
import me.aquitano.health.domain.HealthProvider
import me.aquitano.health.domain.HealthProviderDescriptor
import me.aquitano.health.domain.ProviderAuthType
import me.aquitano.health.domain.ProviderConnection
import me.aquitano.health.domain.ProviderSyncRequest
import me.aquitano.health.domain.ProviderSyncSummary
import me.aquitano.health.domain.ProviderWorkflowEndpoints
import me.aquitano.health.infrastructure.database.DatabaseFactory
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import me.aquitano.health.infrastructure.repositories.ScheduledSyncRepository
import me.aquitano.health.test.PostgresTestDatabase
import java.time.Instant
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class ScheduledProviderSyncServiceTest {
    @Test
    fun manualRunConflictsWhileScheduledRunIsActiveForSameAccount() = runBlocking {
        val database = DatabaseFactory().initialize(PostgresTestDatabase.config())
        val repository = ScheduledSyncRepository(database)
        val provider = BlockingProvider()
        val service = ScheduledProviderSyncService(
            providerRegistry = HealthProviderRegistry(listOf(provider)),
            providerOAuthRepository = ProviderOAuthRepository(database),
            repository = repository,
            runGuard = ScheduledSyncRunGuard(),
        )
        val now = Instant.parse("2026-05-31T10:00:00Z")

        repository.upsertConfig(
            providerCode = provider.providerCode,
            providerInstanceId = provider.defaultProviderInstanceId,
            enabled = true,
            dataTypes = listOf("steps"),
            cadenceMinutes = 1_440,
            lookbackDays = 7,
            nextRunAt = now,
            now = now,
        )

        coroutineScope {
            val scheduledRun = async { service.runDue(now) }
            provider.started.await()

            val conflict = assertFailsWith<ConflictException> {
                service.runNow(provider.providerCode, provider.defaultProviderInstanceId, now)
            }

            provider.release.complete(Unit)
            assertEquals("scheduled_sync_already_running", conflict.code)
            assertEquals(1, scheduledRun.await())
            assertEquals(1, provider.syncCalls.get())
        }
    }

    private class BlockingProvider : HealthProvider {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val syncCalls = AtomicInteger(0)

        override val providerCode = "blocking_provider"
        override val defaultProviderInstanceId = "blocking-provider-me"
        override val descriptor = HealthProviderDescriptor(
            providerCode = providerCode,
            displayName = "Blocking Provider",
            authType = ProviderAuthType.NONE,
            requiresAuthentication = false,
            supportedDataTypes = listOf("steps"),
            defaultDataTypes = listOf("steps"),
            maxSyncRangeDays = 31,
            supportsPageSize = false,
            workflowEndpoints = ProviderWorkflowEndpoints(sync = "/sync"),
        )

        override fun isConfigured(): Boolean = true

        override fun getAuthUrl(state: String): String = error("OAuth is not supported")

        override suspend fun connect(code: String, now: Instant): ProviderConnection =
            error("OAuth is not supported")

        override suspend fun sync(
            request: ProviderSyncRequest,
            now: Instant,
        ): ProviderSyncSummary {
            syncCalls.incrementAndGet()
            started.complete(Unit)
            release.await()
            return ProviderSyncSummary(
                providerCode = providerCode,
                providerInstanceId = request.providerInstanceId ?: defaultProviderInstanceId,
                requestedFrom = request.from,
                requestedTo = request.to,
                status = "processed",
                batches = emptyList(),
                errors = emptyList(),
            )
        }
    }
}

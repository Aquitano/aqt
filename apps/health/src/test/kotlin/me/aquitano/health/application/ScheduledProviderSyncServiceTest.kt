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
import kotlin.test.assertNotNull
import kotlin.test.assertNull

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

    @Test
    fun nonRetryableFailureParksConfigEvenWhenMessageIsReworded() = runBlocking {
        // The ConflictException message deliberately avoids the old magic substrings;
        // classification must come from the exception type, not the wording.
        val provider = ThrowingProvider(
            ConflictException("withings_needs_reauth", "token expired, reauthorize the account")
        )
        val (service, repository) = serviceWith(provider)
        val now = Instant.parse("2026-05-31T10:00:00Z")
        configureEnabled(repository, provider, now)

        assertEquals(1, service.runDue(now))

        val config = repository.getConfig(provider.providerCode, provider.defaultProviderInstanceId)
        assertNotNull(config)
        assertNull(config.nextRunAt)
        assertEquals(1, config.failureCount)
    }

    @Test
    fun transientFailureKeepsRetryingEvenWhenMessageMentionsValidation() = runBlocking {
        val provider = ThrowingProvider(
            IllegalStateException("upstream response failed schema validation, not connected to peer")
        )
        val (service, repository) = serviceWith(provider)
        val now = Instant.parse("2026-05-31T10:00:00Z")
        configureEnabled(repository, provider, now)

        assertEquals(1, service.runDue(now))

        val config = repository.getConfig(provider.providerCode, provider.defaultProviderInstanceId)
        assertNotNull(config)
        assertEquals(ScheduledSyncPolicy.nextRunAfterFailure(now, 1), config.nextRunAt)
        assertEquals(1, config.failureCount)
    }

    private fun serviceWith(
        provider: HealthProvider,
    ): Pair<ScheduledProviderSyncService, ScheduledSyncRepository> {
        val database = DatabaseFactory().initialize(PostgresTestDatabase.config())
        val repository = ScheduledSyncRepository(database)
        val service = ScheduledProviderSyncService(
            providerRegistry = HealthProviderRegistry(listOf(provider)),
            providerOAuthRepository = ProviderOAuthRepository(database),
            repository = repository,
            runGuard = ScheduledSyncRunGuard(),
        )
        return service to repository
    }

    private suspend fun configureEnabled(
        repository: ScheduledSyncRepository,
        provider: HealthProvider,
        now: Instant,
    ) {
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
    }

    private class ThrowingProvider(private val failure: Exception) : HealthProvider {
        override val providerCode = "throwing_provider"
        override val defaultProviderInstanceId = "throwing-provider-me"
        override val descriptor = HealthProviderDescriptor(
            providerCode = providerCode,
            displayName = "Throwing Provider",
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
        ): ProviderSyncSummary = throw failure
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

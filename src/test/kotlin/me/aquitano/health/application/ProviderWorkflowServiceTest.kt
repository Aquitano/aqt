package me.aquitano.health.application

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import me.aquitano.health.api.dto.ProviderSyncRequest
import me.aquitano.health.domain.ConflictException
import me.aquitano.health.domain.HealthProvider
import me.aquitano.health.domain.HealthProviderDescriptor
import me.aquitano.health.domain.ProviderAuthType
import me.aquitano.health.domain.ProviderConnection
import me.aquitano.health.domain.ProviderSyncSummary
import me.aquitano.health.domain.ProviderWorkflowEndpoints
import me.aquitano.health.infrastructure.database.DatabaseFactory
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import me.aquitano.health.infrastructure.repositories.ProviderSyncIdempotencyRepository
import me.aquitano.health.infrastructure.time.UtcClock
import me.aquitano.health.test.PostgresTestDatabase
import java.time.Instant
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import me.aquitano.health.domain.ProviderSyncRequest as DomainProviderSyncRequest

class ProviderWorkflowServiceTest {
    private val now = Instant.parse("2026-05-01T10:00:00Z")

    // No providerInstanceId: the removed canReplaySafely gate used to skip idempotent replay for
    // these requests, so the provider ran on every duplicate.
    private fun request(
        from: String = "2026-05-01T00:00:00Z",
        to: String = "2026-05-08T00:00:00Z",
    ) = ProviderSyncRequest(from = from, to = to, dataTypes = listOf("steps"))

    @Test
    fun syncWithoutProviderInstanceIdReplaysStoredResponseForSameKey() = runBlocking {
        val provider = CountingProvider()
        val service = serviceWith(provider)
        val key = "workflow-replay-key"

        val first = service.sync(provider.providerCode, request(), now, key)
        val second = service.sync(provider.providerCode, request(), now, key)

        assertEquals(first, second)
        assertEquals(1, provider.syncCalls.get())
    }

    @Test
    fun syncSameKeyDifferentRequestConflictsWithoutProviderInstanceId() = runBlocking {
        val provider = CountingProvider()
        val service = serviceWith(provider)
        val key = "workflow-conflict-key"

        service.sync(provider.providerCode, request(), now, key)
        val conflict = assertFailsWith<ConflictException> {
            service.sync(provider.providerCode, request(to = "2026-05-09T00:00:00Z"), now, key)
        }

        assertEquals("idempotency_key_conflict", conflict.code)
        assertEquals(1, provider.syncCalls.get())
    }

    @Test
    fun concurrentSyncWithSameKeyExecutesProviderOnce() = runBlocking {
        val provider = BlockingProvider()
        val service = serviceWith(provider)
        val key = "workflow-concurrent-key"

        val responses = coroutineScope {
            val first = async { service.sync(provider.providerCode, request(), now, key) }
            provider.started.await()
            val second = async { service.sync(provider.providerCode, request(), now, key) }
            provider.release.complete(Unit)
            listOf(first, second).awaitAll()
        }

        assertEquals(responses[0], responses[1])
        assertEquals(1, provider.syncCalls.get())
    }

    @Test
    fun syncWithoutKeyExecutesEveryTime() = runBlocking {
        val provider = CountingProvider()
        val service = serviceWith(provider)

        service.sync(provider.providerCode, request(), now, idempotencyKey = null)
        service.sync(provider.providerCode, request(), now, idempotencyKey = null)

        assertEquals(2, provider.syncCalls.get())
    }

    private fun serviceWith(provider: HealthProvider): ProviderWorkflowService {
        val database = DatabaseFactory().initialize(PostgresTestDatabase.config())
        val registry = HealthProviderRegistry(listOf(provider))
        val oAuthRepository = ProviderOAuthRepository(database)
        return ProviderWorkflowService(
            providerRegistry = registry,
            providerOAuthRepository = oAuthRepository,
            providerStatusService = ProviderStatusService(registry, oAuthRepository),
            syncIdempotencyRepository = ProviderSyncIdempotencyRepository(database),
        )
    }

    private class BlockingProvider : HealthProvider {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val syncCalls = AtomicInteger(0)

        override val providerCode = "blocking_provider"
        override val defaultProviderInstanceId = "blocking-provider-me"
        override val descriptor = descriptorFor(providerCode, "Blocking Provider")

        override fun isConfigured(): Boolean = true

        override fun getAuthUrl(state: String): String = error("OAuth is not supported")

        override suspend fun connect(code: String, now: Instant): ProviderConnection =
            error("OAuth is not supported")

        override suspend fun sync(
            request: DomainProviderSyncRequest,
            now: Instant,
        ): ProviderSyncSummary {
            syncCalls.incrementAndGet()
            started.complete(Unit)
            release.await()
            return summaryFor(request)
        }
    }

    private class CountingProvider : HealthProvider {
        val syncCalls = AtomicInteger(0)

        override val providerCode = "counting_provider"
        override val defaultProviderInstanceId = "counting-provider-me"
        override val descriptor = descriptorFor(providerCode, "Counting Provider")

        override fun isConfigured(): Boolean = true

        override fun getAuthUrl(state: String): String = error("OAuth is not supported")

        override suspend fun connect(code: String, now: Instant): ProviderConnection =
            error("OAuth is not supported")

        override suspend fun sync(
            request: DomainProviderSyncRequest,
            now: Instant,
        ): ProviderSyncSummary {
            syncCalls.incrementAndGet()
            return summaryFor(request)
        }
    }

    private companion object {
        fun descriptorFor(providerCode: String, displayName: String) = HealthProviderDescriptor(
            providerCode = providerCode,
            displayName = displayName,
            authType = ProviderAuthType.NONE,
            requiresAuthentication = false,
            supportedDataTypes = listOf("steps"),
            defaultDataTypes = listOf("steps"),
            maxSyncRangeDays = 31,
            supportsPageSize = false,
            workflowEndpoints = ProviderWorkflowEndpoints(sync = "/sync"),
        )

        fun HealthProvider.summaryFor(request: DomainProviderSyncRequest): ProviderSyncSummary =
            ProviderSyncSummary(
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

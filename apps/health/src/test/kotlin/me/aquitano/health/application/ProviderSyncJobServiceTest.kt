package me.aquitano.health.application

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import me.aquitano.health.api.dto.ProviderSyncRequest
import me.aquitano.health.domain.HealthProvider
import me.aquitano.health.domain.HealthProviderDescriptor
import me.aquitano.health.domain.ProviderAuthType
import me.aquitano.health.domain.ProviderConnection
import me.aquitano.health.domain.ProviderSyncSummary
import me.aquitano.health.domain.ProviderWorkflowEndpoints
import me.aquitano.health.domain.SyncJobStatus
import me.aquitano.health.infrastructure.database.DatabaseFactory
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import me.aquitano.health.infrastructure.repositories.ProviderSyncIdempotencyRepository
import me.aquitano.health.infrastructure.repositories.ProviderSyncJobRepository
import me.aquitano.health.infrastructure.time.UtcClock
import me.aquitano.health.test.PostgresTestDatabase
import org.jetbrains.exposed.v1.jdbc.Database
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import me.aquitano.health.domain.ProviderSyncRequest as DomainProviderSyncRequest

class ProviderSyncJobServiceTest {
    private val now = Instant.parse("2026-05-01T10:00:00Z")
    private val request = ProviderSyncRequest(
        from = "2026-05-01T00:00:00Z",
        to = "2026-05-08T00:00:00Z",
        dataTypes = listOf("steps"),
    )

    @Test
    fun concurrentCreateWithSameKeyLaunchesJobOnce() = runBlocking {
        val provider = BlockingProvider()
        val fixture = Fixture(provider)
        val key = "sync-job-concurrent-key"

        val jobIds = coroutineScope {
            val first = async { fixture.service.create(provider.providerCode, request, now, key) }
            val second = async { fixture.service.create(provider.providerCode, request, now, key) }
            listOf(first, second).awaitAll()
        }.map { it.jobId }

        assertEquals(jobIds[0], jobIds[1], "duplicate key must resolve to the same job")

        provider.started.await()
        provider.release.complete(Unit)

        val terminal = withTimeout(30_000) {
            var job = fixture.service.get(jobIds[0])
            while (!job.status.terminal) {
                delay(50)
                job = fixture.service.get(jobIds[0])
            }
            job
        }

        assertEquals(1, provider.syncCalls.get(), "provider must run exactly once for a duplicate key")
        assertEquals(SyncJobStatus.Processed, terminal.status)
    }

    @Test
    fun createReportsExistingJobOnDuplicateIdempotencyKey() = runBlocking {
        val database = database()
        val repository = ProviderSyncJobRepository(database)
        val key = "sync-job-repo-flag-key"
        val id1 = UUID.randomUUID().toString()
        val id2 = UUID.randomUUID().toString()

        val first = repository.create(
            id = id1,
            providerCode = "blocking_provider",
            providerInstanceId = null,
            requestedFrom = now,
            requestedTo = now.plusSeconds(3600),
            dataTypes = null,
            pageSize = null,
            now = now,
            idempotencyKey = key,
            idempotencyRequestHash = "hash-a",
        )
        val second = repository.create(
            id = id2,
            providerCode = "blocking_provider",
            providerInstanceId = null,
            requestedFrom = now,
            requestedTo = now.plusSeconds(3600),
            dataTypes = null,
            pageSize = null,
            now = now,
            idempotencyKey = key,
            idempotencyRequestHash = "hash-a",
        )

        assertTrue(first.created)
        assertFalse(second.created)
        assertEquals(id1, second.record.id)
    }

    @Test
    fun createWithoutKeyLaunchesEveryTime() = runBlocking {
        val provider = CountingProvider()
        val fixture = Fixture(provider)

        val first = fixture.service.create(provider.providerCode, request, now, idempotencyKey = null)
        val second = fixture.service.create(provider.providerCode, request, now, idempotencyKey = null)

        assertNotEquals(first.jobId, second.jobId)

        withTimeout(30_000) {
            listOf(first.jobId, second.jobId).forEach { jobId ->
                var job = fixture.service.get(jobId)
                while (!job.status.terminal) {
                    delay(50)
                    job = fixture.service.get(jobId)
                }
            }
        }

        assertEquals(2, provider.syncCalls.get())
    }

    private fun database(): Database = DatabaseFactory().initialize(PostgresTestDatabase.config())

    private inner class Fixture(provider: HealthProvider) {
        val database = database()
        private val registry = HealthProviderRegistry(listOf(provider))
        private val oAuthRepository = ProviderOAuthRepository(database)
        private val workflowService = ProviderWorkflowService(
            providerRegistry = registry,
            providerOAuthRepository = oAuthRepository,
            providerStatusService = ProviderStatusService(registry, oAuthRepository),
            syncIdempotencyRepository = ProviderSyncIdempotencyRepository(database),
        )
        val service = ProviderSyncJobService(
            providerRegistry = registry,
            workflowService = workflowService,
            repository = ProviderSyncJobRepository(database),
            clock = UtcClock(),
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

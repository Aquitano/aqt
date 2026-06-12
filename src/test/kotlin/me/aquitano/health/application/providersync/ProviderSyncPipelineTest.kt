package me.aquitano.health.application.providersync

import me.aquitano.health.infrastructure.time.UtcClock
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import me.aquitano.health.api.dto.StepIntervalDto
import me.aquitano.health.domain.*
import java.time.Duration
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class ProviderSyncPipelineTest {
    private val now: Instant = Instant.parse("2026-04-20T10:00:00Z")
    private val request = ProviderSyncRequest(
        from = Instant.parse("2026-04-01T00:00:00Z"),
        to = Instant.parse("2026-04-02T00:00:00Z"),
        dataTypes = listOf("steps"),
    )

    @Test
    fun processedBatchCacheSkipsProviderFetch() = runBlocking {
        val accountPort = FakeAccountPort()
        val ingestion = FakeIngestionPort(
            existingBatch = ExistingProviderBatch(id = 42, status = "processed"),
        )
        val adapter = FakeAdapter()
        val pipeline = ProviderSyncPipeline(accountPort, FakeRunPort(), ingestion)

        val summary = pipeline.sync(adapter, request, now)

        assertEquals(0, adapter.fetchCalls)
        assertEquals(1, summary.batches.size)
        assertEquals(true, summary.batches.single().duplicateBatch)
        assertEquals(42, summary.batches.single().batchId)
    }

    @Test
    fun invalidRefreshTokenMarksAccountNeedsReauthBeforeStartingRun() = runBlocking {
        val accountPort = FakeAccountPort(
            account = syncAccount(expiresAt = now.minusSeconds(1)),
        )
        val runPort = FakeRunPort()
        val adapter = FakeAdapter(
            refreshFailure = InvalidRefreshToken(),
        )
        val pipeline = ProviderSyncPipeline(accountPort, runPort, FakeIngestionPort())

        val error = assertFailsWith<ConflictException> {
            pipeline.sync(adapter, request, now)
        }

        assertEquals("fake_needs_reauth", error.code)
        assertEquals("fake_needs_reauth", accountPort.needsReauthCode)
        assertEquals(0, runPort.started)
    }

    @Test
    fun unauthorizedFetchRefreshesTokenAndRetriesOnce() = runBlocking {
        val accountPort = FakeAccountPort()
        val adapter = FakeAdapter(throwUnauthorizedOnce = true)
        val ingestion = FakeIngestionPort()
        val pipeline = ProviderSyncPipeline(
            accountPort,
            FakeRunPort(),
            ingestion,
            clock = UtcClock.fixed(now),
        )

        val summary = pipeline.sync(adapter, request, now)

        assertEquals(2, adapter.fetchCalls)
        assertEquals(1, adapter.refreshCalls)
        assertEquals("fresh-access", accountPort.savedAccessToken)
        assertEquals(1, ingestion.ingested.size)
        assertEquals("processed", summary.status)
    }

    @Test
    fun providerFetchesAreThrottledBetweenUncachedItems() = runBlocking {
        val delays = mutableListOf<Duration>()
        val adapter = FakeAdapter(
            itemCount = 2,
            providerRequestInterval = Duration.ofSeconds(5),
        )
        val pipeline = ProviderSyncPipeline(
            FakeAccountPort(),
            FakeRunPort(),
            FakeIngestionPort(),
            throttleDelay = { delays += it },
        )

        val summary = pipeline.sync(adapter, request, now)

        assertEquals(2, adapter.fetchCalls)
        assertEquals(2, summary.batches.size)
        assertEquals(1, delays.size)
        assertTrue(delays.single() > Duration.ZERO)
    }

    private class FakeAdapter(
        private val refreshFailure: RuntimeException? = null,
        private var throwUnauthorizedOnce: Boolean = false,
        private val itemCount: Int = 1,
        override val providerRequestInterval: Duration = Duration.ZERO,
    ) : ProviderSyncAdapter {
        var fetchCalls = 0
        var refreshCalls = 0

        override val providerCode = "fake"
        override val defaultSyncFailureMessage = "Fake sync failed"
        override val tokenRefreshFailureCode = "fake_refresh_failed"
        override val tokenRefreshFailureMessage = "Fake refresh failed"
        override val needsReauthCode = "fake_needs_reauth"
        override val needsReauthMessage = "Fake needs reconnect"

        override fun validate(request: ProviderSyncRequest): ProviderSyncPlan =
            ProviderSyncPlan(
                providerInstanceId = request.providerInstanceId,
                requestedFrom = request.from,
                requestedTo = request.to,
                items = (1..itemCount).map { index ->
                    ProviderSyncItem(
                        dataType = "steps",
                        from = request.from.plusSeconds((index - 1).toLong()),
                        to = request.to.plusSeconds((index - 1).toLong()),
                    )
                },
            )

        override fun accountUnavailable(
            providerInstanceId: String?,
            statusHint: SyncAccount?,
        ): Throwable = ConflictException("fake_not_connected", "Fake is not connected")

        override suspend fun refreshAccessToken(
            refreshToken: String,
            account: SyncAccount,
            now: Instant,
        ): RefreshedTokenSet {
            refreshCalls += 1
            refreshFailure?.let { throw it }
            return RefreshedTokenSet(
                accessToken = "fresh-access",
                refreshToken = "fresh-refresh",
                tokenType = "Bearer",
                expiresAt = now.plusSeconds(3600),
                scope = "scope",
            )
        }

        override suspend fun fetch(
            accessToken: String,
            account: SyncAccount,
            item: ProviderSyncItem,
            now: Instant,
        ): ProviderFetchedBatch {
            fetchCalls += 1
            if (throwUnauthorizedOnce) {
                throwUnauthorizedOnce = false
                throw UnauthorizedFetch()
            }
            return ProviderFetchedBatch(
                dataType = item.dataType,
                pagesFetched = 1,
                sourceRecordsReceived = 1,
                sourcePayload = buildJsonObject {},
                records = listOf(
                    StepIntervalDto(
                        providerRecordId = "steps-1",
                        startAt = "2026-04-01T08:00:00Z",
                        endAt = "2026-04-01T09:00:00Z",
                        steps = 1200,
                    )
                ),
            )
        }

        override fun isUnauthorized(error: Throwable): Boolean =
            error is UnauthorizedFetch

        override fun isInvalidRefreshToken(error: Throwable): Boolean =
            error is InvalidRefreshToken

        override fun batchExternalId(
            providerInstanceId: String,
            item: ProviderSyncItem,
        ): String = "fake:$providerInstanceId:${item.dataType}:${item.from}:${item.to}"

        override fun errorCode(error: Throwable): String = "fake_sync_failed"
    }

    private class FakeAccountPort(
        private val account: SyncAccount = syncAccount(),
    ) : ProviderSyncAccountPort {
        var needsReauthCode: String? = null
        var savedAccessToken: String? = null

        override suspend fun selectForSync(
            providerCode: String,
            providerInstanceId: String?,
        ): SyncAccount = account

        override suspend fun findAnyForStatusHint(
            providerCode: String,
            providerInstanceId: String?,
        ): SyncAccount = account

        override suspend fun decryptAccessToken(account: SyncAccount): String =
            "access"

        override suspend fun decryptRefreshToken(account: SyncAccount): String =
            "refresh"

        override suspend fun saveRefreshedToken(
            accountId: Int,
            tokens: RefreshedTokenSet,
            previousRefreshToken: String,
            now: Instant,
        ) {
            savedAccessToken = tokens.accessToken
        }

        override suspend fun markNeedsReauth(
            accountId: Int,
            code: String,
            message: String,
            now: Instant,
        ) {
            needsReauthCode = code
        }

        override suspend fun markTokenRefreshFailed(
            accountId: Int,
            code: String,
            message: String,
            now: Instant,
        ) = Unit
    }

    private class FakeRunPort : ProviderSyncRunPort {
        var started = 0

        override suspend fun start(
            providerCode: String,
            providerInstanceId: String,
            requestedFrom: Instant,
            requestedTo: Instant,
            startedAt: Instant,
        ): Int {
            started += 1
            return 7
        }

        override suspend fun finish(
            runId: Int,
            status: String,
            finishedAt: Instant,
            errorMessage: String?,
        ) = Unit
    }

    private class FakeIngestionPort(
        private val existingBatch: ExistingProviderBatch? = null,
    ) : ProviderSyncIngestionPort {
        val ingested = mutableListOf<ProviderIngestionCommand>()

        override suspend fun findExistingBatch(
            providerCode: String,
            providerInstanceId: String,
            batchExternalId: String,
            now: Instant,
        ): ExistingProviderBatch? = existingBatch

        override suspend fun ingest(
            command: ProviderIngestionCommand,
            now: Instant,
        ): ProviderSyncBatch {
            ingested += command
            return ProviderSyncBatch(
                dataType = command.dataType,
                batchId = 1,
                duplicateBatch = false,
                recordsReceived = command.records.size,
                ingestionRecordsStored = command.records.size,
                metricsCreated = MetricCreatedCounts.of(StructuralMetricKinds.STEP_SAMPLES to command.records.size),
                duplicateMetricsSkipped = 0,
                affectedStepSummaryDates = listOf("2026-04-01"),
            )
        }
    }

    private class UnauthorizedFetch : RuntimeException("unauthorized")

    private class InvalidRefreshToken : RuntimeException("invalid refresh")
}

private fun syncAccount(
    expiresAt: Instant = Instant.parse("2026-04-20T11:00:00Z"),
): SyncAccount =
    SyncAccount(
        id = 1,
        providerCode = "fake",
        providerUserId = "fake-user",
        providerInstanceId = "fake-instance",
        encryptedAccessToken = "encrypted-access",
        encryptedRefreshToken = "encrypted-refresh",
        expiresAt = expiresAt,
        accountStatus = "connected",
    )

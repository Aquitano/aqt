package me.aquitano.health.application.providersync

import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import me.aquitano.health.domain.*
import me.aquitano.health.infrastructure.time.UtcClock
import io.github.oshai.kotlinlogging.KotlinLogging
import me.aquitano.health.infrastructure.logging.*
import java.time.Duration
import java.time.Instant
import java.util.concurrent.CancellationException
import java.util.concurrent.ConcurrentHashMap

private val logger = KotlinLogging.logger {}

class ProviderSyncPipeline(
    private val accounts: ProviderSyncAccountPort,
    private val runs: ProviderSyncRunPort,
    private val ingestion: ProviderSyncIngestionPort,
    private val throttleDelay: suspend (Duration) -> Unit = { delay(it.toMillis()) },
    private val clock: UtcClock = UtcClock(),
) {
    // Serializes the token-refresh critical section per account so a manual + scheduled + sync-job
    // run for the same account can't interleave refreshAccessToken/saveRefreshedToken and invalidate
    // each other's rotating refresh token (Google), bricking the account into needs_reauth. Only the
    // short refresh window is guarded, not the whole sync, so the synchronous POST /sync path never
    // blocks for the length of a backfill. Process-local: the pipeline is a per-provider singleton,
    // so this covers every in-process sync path. Multi-instance deploys still need a DB-backed claim
    // (same gap noted on ScheduledSyncRunGuard).
    private val accountTokenLocks = ConcurrentHashMap<String, Mutex>()

    private fun accountTokenLock(providerCode: String, providerInstanceId: String): Mutex =
        accountTokenLocks.computeIfAbsent("$providerCode:$providerInstanceId") { Mutex() }

    suspend fun sync(
        adapter: ProviderSyncAdapter,
        request: ProviderSyncRequest,
        now: Instant,
        progress: ProviderSyncProgressSink = ProviderSyncProgressSink.None,
    ): ProviderSyncSummary {
        val plan = adapter.validate(request)
        val account = accounts.selectForSync(
            adapter.providerCode,
            plan.providerInstanceId,
        ) ?: throw adapter.accountUnavailable(
            plan.providerInstanceId,
            accounts.findAnyForStatusHint(adapter.providerCode, plan.providerInstanceId),
        )

        var token = freshAccessToken(adapter, account, clock.now())
        val runId = runs.start(
            providerCode = adapter.providerCode,
            providerInstanceId = account.providerInstanceId,
            requestedFrom = plan.requestedFrom,
            requestedTo = plan.requestedTo,
            startedAt = now,
        )
        logger.infoWithContext(
            "provider_sync_started",
            mapOf(
                "provider" to adapter.providerCode,
                "providerInstanceId" to account.providerInstanceId,
                "from" to plan.requestedFrom,
                "to" to plan.requestedTo,
                "dataTypes" to plan.items.map { it.dataType }.distinct()
            )
        )
        progress.started(plan.items.size, account.providerInstanceId)

        val batches = mutableListOf<ProviderSyncBatch>()
        val errors = mutableListOf<ProviderSyncError>()
        val emptyDataTypes = mutableListOf<ProviderSyncEmptyDataType>()
        var lastProviderRequestCompletedAtNanos: Long? = null

        plan.items.forEach { item ->
            progress.itemStarted(item)
            val batchExternalId = adapter.batchExternalId(
                providerInstanceId = account.providerInstanceId,
                item = item,
            )
            val existingBatch = ingestion.findExistingBatch(
                providerCode = adapter.providerCode,
                providerInstanceId = account.providerInstanceId,
                batchExternalId = batchExternalId,
                now = now,
            )
            if (existingBatch?.status == "processed") {
                batches += cachedBatchResponse(item.dataType, existingBatch.id)
                logger.infoWithContext(
                    "provider_sync_cache_hit",
                    mapOf(
                        "provider" to adapter.providerCode,
                        "providerInstanceId" to account.providerInstanceId,
                        "dataType" to item.dataType,
                        "batchId" to existingBatch.id,
                        "from" to item.from
                    )
                )
                progress.itemCompleted(item)
                return@forEach
            }

            try {
                val fetched = try {
                    throttledFetch(
                        adapter = adapter,
                        lastCompletedAtNanos = lastProviderRequestCompletedAtNanos,
                        accessToken = token.accessToken,
                        account = account,
                        item = item,
                        now = clock.now(),
                    ).also { lastProviderRequestCompletedAtNanos = it.completedAtNanos }.batch
                } catch (exception: Throwable) {
                    if (exception is CancellationException) throw exception
                    if (!adapter.isUnauthorized(exception)) throw exception
                    token = obtainAccessToken(
                        adapter = adapter,
                        providerInstanceId = account.providerInstanceId,
                        now = clock.now(),
                        forceRefresh = true,
                        usedRefreshToken = token.refreshToken,
                    )
                    throttledFetch(
                        adapter = adapter,
                        lastCompletedAtNanos = lastProviderRequestCompletedAtNanos,
                        accessToken = token.accessToken,
                        account = account,
                        item = item,
                        now = clock.now(),
                    ).also { lastProviderRequestCompletedAtNanos = it.completedAtNanos }.batch
                }

                if (fetched.records.isEmpty()) {
                    if (adapter.recordEmptyDataTypes) {
                        emptyDataTypes += ProviderSyncEmptyDataType(
                            dataType = item.dataType,
                            pagesFetched = fetched.pagesFetched,
                            sourceRecordsReceived = fetched.sourceRecordsReceived,
                            normalizedRecords = 0,
                        )
                    }
                    logger.infoWithContext(
                        "provider_data_type_synced",
                        mapOf(
                            "provider" to adapter.providerCode,
                            "dataType" to item.dataType,
                            "pages" to fetched.pagesFetched,
                            "sourceRecords" to fetched.sourceRecordsReceived,
                            "normalizedRecords" to 0
                        )
                    )
                    progress.itemCompleted(item)
                    return@forEach
                }

                val sourcePayload = adapter.sourcePayload(
                    ProviderSourcePayloadContext(
                        providerCode = adapter.providerCode,
                        providerInstanceId = account.providerInstanceId,
                        item = item,
                        fetched = fetched,
                        now = now,
                    )
                )
                val batch = ingestion.ingest(
                    ProviderIngestionCommand(
                        providerCode = adapter.providerCode,
                        providerInstanceId = account.providerInstanceId,
                        batchExternalId = batchExternalId,
                        dataType = item.dataType,
                        ingestedAt = now,
                        sourcePayload = sourcePayload,
                        records = fetched.records,
                    ),
                    now = now,
                )
                batches += batch
                logger.infoWithContext(
                    "provider_data_type_synced",
                    mapOf(
                        "provider" to adapter.providerCode,
                        "dataType" to item.dataType,
                        "pages" to fetched.pagesFetched,
                        "records" to fetched.records.size,
                        "batchId" to batch.batchId,
                        "duplicateBatch" to batch.duplicateBatch
                    )
                )
                progress.itemCompleted(item)
            } catch (exception: Exception) {
                if (exception is CancellationException) throw exception
                val code = adapter.errorCode(exception)
                val safeMessage = exception.message
                    ?.take(500)
                    ?: adapter.defaultSyncFailureMessage
                val providerAttributes = adapter.errorAttributes(exception)
                logger.warnWithContext(
                    "provider_data_type_failed",
                    mapOf(
                        "provider" to adapter.providerCode,
                        "dataType" to item.dataType,
                        "from" to item.from,
                        "to" to item.to,
                        "errorCode" to code,
                        "errorMessage" to safeMessage,
                        "exceptionClass" to (exception::class.qualifiedName ?: exception::class.simpleName),
                        "providerError" to providerAttributes
                    ),
                    exception
                )
                errors += ProviderSyncError(
                    dataType = item.dataType,
                    code = code,
                    message = safeMessage,
                    retryable = isRetryableSyncFailure(exception),
                )
                progress.itemCompleted(item)
            }
        }

        val status = when {
            errors.isEmpty() -> "processed"
            batches.isEmpty() -> "failed"
            else -> "partial_failed"
        }
        runs.finish(
            runId = runId,
            status = status,
            finishedAt = now,
            errorMessage = errors.joinToString("; ") { "${it.dataType}: ${it.message}" }
                .ifBlank { null },
        )
        val context = mapOf(
            "provider" to adapter.providerCode,
            "syncRunId" to runId,
            "status" to status,
            "batchCount" to batches.size,
            "errorCount" to errors.size
        )
        when (status) {
            "processed" -> logger.infoWithContext("provider_sync_completed", context)
            "partial_failed" -> logger.warnWithContext("provider_sync_completed", context)
            else -> logger.errorWithContext("provider_sync_completed", context)
        }

        if (batches.isEmpty() && errors.isNotEmpty()) {
            val first = errors.first()
            throw UpstreamProviderException(first.code, first.message, 502, retryable = first.retryable)
        }

        return ProviderSyncSummary(
            providerCode = adapter.providerCode,
            providerInstanceId = account.providerInstanceId,
            requestedFrom = plan.requestedFrom,
            requestedTo = plan.requestedTo,
            status = status,
            batches = batches,
            errors = errors,
            emptyDataTypes = emptyDataTypes,
        )
    }

    private suspend fun throttledFetch(
        adapter: ProviderSyncAdapter,
        lastCompletedAtNanos: Long?,
        accessToken: String,
        account: SyncAccount,
        item: ProviderSyncItem,
        now: Instant,
    ): ThrottledFetchResult {
        val interval = adapter.providerRequestInterval
        if (!interval.isZero && !interval.isNegative && lastCompletedAtNanos != null) {
            val elapsedNanos = System.nanoTime() - lastCompletedAtNanos
            val remainingNanos = interval.toNanos() - elapsedNanos
            if (remainingNanos > 0) {
                throttleDelay(Duration.ofNanos(remainingNanos))
            }
        }
        val batch = adapter.fetch(
            accessToken = accessToken,
            account = account,
            item = item,
            now = now,
        )
        return ThrottledFetchResult(batch, System.nanoTime())
    }

    private suspend fun freshAccessToken(
        adapter: ProviderSyncAdapter,
        account: SyncAccount,
        now: Instant,
    ): ProviderAccessToken {
        if (account.expiresAt.isAfter(now.plusSeconds(60))) {
            return ProviderAccessToken(
                accounts.decryptAccessToken(account),
                accounts.decryptRefreshToken(account),
            )
        }
        return obtainAccessToken(
            adapter = adapter,
            providerInstanceId = account.providerInstanceId,
            now = now,
            forceRefresh = false,
            usedRefreshToken = null,
        )
    }

    /**
     * Under the per-account lock, re-reads the account and refreshes only if still needed, so two
     * concurrent runs don't both refresh: the second observes the token the first already rotated
     * and reuses it. [forceRefresh] handles a mid-sync 401 — refresh unless another run already
     * rotated the refresh token we just failed with (then its newer token is returned instead).
     */
    private suspend fun obtainAccessToken(
        adapter: ProviderSyncAdapter,
        providerInstanceId: String,
        now: Instant,
        forceRefresh: Boolean,
        usedRefreshToken: String?,
    ): ProviderAccessToken =
        accountTokenLock(adapter.providerCode, providerInstanceId).withLock {
            val current = accounts.selectForSync(adapter.providerCode, providerInstanceId)
                ?: throw adapter.accountUnavailable(
                    providerInstanceId,
                    accounts.findAnyForStatusHint(adapter.providerCode, providerInstanceId),
                )
            val currentRefreshToken = accounts.decryptRefreshToken(current)
            val refreshNeeded =
                if (forceRefresh) currentRefreshToken == usedRefreshToken
                else !current.expiresAt.isAfter(now.plusSeconds(60))
            if (refreshNeeded) {
                refreshAccessToken(adapter, current, currentRefreshToken, now)
            } else {
                ProviderAccessToken(accounts.decryptAccessToken(current), currentRefreshToken)
            }
        }

    private suspend fun refreshAccessToken(
        adapter: ProviderSyncAdapter,
        account: SyncAccount,
        refreshToken: String,
        now: Instant,
    ): ProviderAccessToken {
        val refreshed = try {
            adapter.refreshAccessToken(refreshToken, account, now)
        } catch (exception: Exception) {
            if (exception is CancellationException) throw exception
            val message = exception.message ?: adapter.tokenRefreshFailureMessage
            if (adapter.isInvalidRefreshToken(exception)) {
                accounts.markNeedsReauth(
                    accountId = account.id,
                    code = adapter.needsReauthCode,
                    message = message,
                    now = now,
                )
                throw ConflictException(
                    code = adapter.needsReauthCode,
                    message = adapter.needsReauthMessage,
                    cause = exception,
                )
            }
            accounts.markTokenRefreshFailed(
                accountId = account.id,
                code = adapter.errorCode(exception),
                message = message,
                now = now,
            )
            throw UpstreamProviderException(
                code = adapter.tokenRefreshFailureCode,
                message = message,
                statusCode = 502,
                cause = exception,
            )
        }

        accounts.saveRefreshedToken(
            accountId = account.id,
            tokens = refreshed,
            previousRefreshToken = refreshToken,
            now = now,
        )
        return ProviderAccessToken(
            accessToken = refreshed.accessToken,
            refreshToken = refreshed.refreshToken ?: refreshToken,
        )
    }

    private fun cachedBatchResponse(
        dataType: String,
        batchId: Int,
    ): ProviderSyncBatch =
        ProviderSyncBatch(
            dataType = dataType,
            batchId = batchId,
            duplicateBatch = true,
            recordsReceived = 0,
            ingestionRecordsStored = 0,
            metricsCreated = MetricCreatedCounts(),
            duplicateMetricsSkipped = 0,
            affectedStepSummaryDates = emptyList(),
        )
}

private data class ThrottledFetchResult(
    val batch: ProviderFetchedBatch,
    val completedAtNanos: Long,
)


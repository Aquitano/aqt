package me.aquitano.health.application.providersync

import kotlinx.coroutines.delay
import me.aquitano.health.domain.*
import net.logstash.logback.argument.StructuredArguments.kv
import org.slf4j.LoggerFactory
import java.time.Duration
import java.time.Instant
import java.util.concurrent.CancellationException

private val logger = LoggerFactory.getLogger(ProviderSyncPipeline::class.java)

class ProviderSyncPipeline(
    private val accounts: ProviderSyncAccountPort,
    private val runs: ProviderSyncRunPort,
    private val ingestion: ProviderSyncIngestionPort,
    private val throttleDelay: suspend (Duration) -> Unit = { delay(it.toMillis()) },
    private val currentTime: () -> Instant = { Instant.now() },
) {
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

        var token = freshAccessToken(adapter, account, currentTime())
        val runId = runs.start(
            providerCode = adapter.providerCode,
            providerInstanceId = account.providerInstanceId,
            requestedFrom = plan.requestedFrom,
            requestedTo = plan.requestedTo,
            startedAt = now,
        )
        logger.info(
            "provider_sync_started {} {} {} {} {}",
            kv("provider", adapter.providerCode),
            kv("providerInstanceId", account.providerInstanceId),
            kv("from", plan.requestedFrom.toString()),
            kv("to", plan.requestedTo.toString()),
            kv("dataTypes", plan.items.map { it.dataType }.distinct()),
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
                logger.info(
                    "provider_sync_cache_hit {} {} {} {} {}",
                    kv("provider", adapter.providerCode),
                    kv("providerInstanceId", account.providerInstanceId),
                    kv("dataType", item.dataType),
                    kv("batchId", existingBatch.id),
                    kv("from", item.from.toString()),
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
                        now = currentTime(),
                    ).also { lastProviderRequestCompletedAtNanos = it.completedAtNanos }.batch
                } catch (exception: Throwable) {
                    if (exception is CancellationException) throw exception
                    if (!adapter.isUnauthorized(exception)) throw exception
                    token = refreshAccessToken(adapter, account, token.refreshToken, currentTime())
                    throttledFetch(
                        adapter = adapter,
                        lastCompletedAtNanos = lastProviderRequestCompletedAtNanos,
                        accessToken = token.accessToken,
                        account = account,
                        item = item,
                        now = currentTime(),
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
                    logger.info(
                        "provider_data_type_synced {} {} {} {} {}",
                        kv("provider", adapter.providerCode),
                        kv("dataType", item.dataType),
                        kv("pages", fetched.pagesFetched),
                        kv("sourceRecords", fetched.sourceRecordsReceived),
                        kv("normalizedRecords", 0),
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
                logger.info(
                    "provider_data_type_synced {} {} {} {} {} {}",
                    kv("provider", adapter.providerCode),
                    kv("dataType", item.dataType),
                    kv("pages", fetched.pagesFetched),
                    kv("records", fetched.records.size),
                    kv("batchId", batch.batchId),
                    kv("duplicateBatch", batch.duplicateBatch),
                )
                progress.itemCompleted(item)
            } catch (exception: Exception) {
                if (exception is CancellationException) throw exception
                val code = adapter.errorCode(exception)
                val safeMessage = exception.message
                    ?.take(500)
                    ?: adapter.defaultSyncFailureMessage
                val providerAttributes = adapter.errorAttributes(exception)
                logger.warn(
                    "provider_data_type_failed {} {} {} {} {} {} {} {}",
                    kv("provider", adapter.providerCode),
                    kv("dataType", item.dataType),
                    kv("from", item.from.toString()),
                    kv("to", item.to.toString()),
                    kv("errorCode", code),
                    kv("errorMessage", safeMessage),
                    kv("exceptionClass", exception::class.qualifiedName ?: exception::class.simpleName),
                    kv("providerError", providerAttributes),
                )
                errors += ProviderSyncError(
                    dataType = item.dataType,
                    code = code,
                    message = safeMessage,
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
        val completionMessage = "provider_sync_completed {} {} {} {} {}"
        val completionArgs = arrayOf(
            kv("provider", adapter.providerCode),
            kv("syncRunId", runId),
            kv("status", status),
            kv("batchCount", batches.size),
            kv("errorCount", errors.size),
        )
        when (status) {
            "processed" -> logger.info(completionMessage, *completionArgs)
            "partial_failed" -> logger.warn(completionMessage, *completionArgs)
            else -> logger.error(completionMessage, *completionArgs)
        }

        if (batches.isEmpty() && errors.isNotEmpty()) {
            val first = errors.first()
            throw UpstreamProviderException(first.code, first.message, 502)
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
        val accessToken = accounts.decryptAccessToken(account)
        val refreshToken = accounts.decryptRefreshToken(account)
        if (account.expiresAt.isAfter(now.plusSeconds(60))) {
            return ProviderAccessToken(accessToken, refreshToken)
        }
        return refreshAccessToken(adapter, account, refreshToken, now)
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

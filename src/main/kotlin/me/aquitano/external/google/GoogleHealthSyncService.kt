package me.aquitano.external.google

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import me.aquitano.health.api.dto.*
import me.aquitano.health.application.IngestionService
import me.aquitano.health.domain.ConflictException
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.UpstreamProviderException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.infrastructure.config.GoogleHealthConfig
import me.aquitano.health.infrastructure.repositories.ProviderOAuthAccount
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import me.aquitano.health.infrastructure.security.TokenCipher
import net.logstash.logback.argument.StructuredArguments.kv
import org.slf4j.LoggerFactory
import java.time.Duration
import java.time.Instant
import java.util.concurrent.CancellationException

private val logger = LoggerFactory.getLogger(GoogleHealthSyncService::class.java)

class GoogleHealthSyncService(
    private val config: GoogleHealthConfig,
    private val repository: ProviderOAuthRepository,
    private val client: GoogleHealthClient,
    private val normalizer: GoogleHealthNormalizer,
    private val ingestionService: IngestionService,
) {
    suspend fun sync(request: GoogleHealthSyncRequest, now: Instant): GoogleHealthSyncResponse {
        val validated = validate(request, now)
        val account = repository.latestAccount(GOOGLE_HEALTH_PROVIDER_CODE)
            ?: throw ConflictException(
                "google_health_not_connected",
                "Google Health is not connected",
            )
        val cipher = TokenCipher(config.tokenEncryptionKey)
        val tokenState = freshAccessToken(account, cipher, now)
        val runId = repository.startSyncRun(
            providerCode = GOOGLE_HEALTH_PROVIDER_CODE,
            providerInstanceId = account.providerInstanceId,
            requestedFrom = validated.from,
            requestedTo = validated.to,
            startedAt = now,
        )
        logger.info(
            "google_health_sync_started {} {} {} {} {}",
            kv("providerInstanceId", account.providerInstanceId),
            kv("from", validated.from.toString()),
            kv("to", validated.to.toString()),
            kv("dataTypes", validated.dataTypes),
            kv("pageSize", validated.pageSize),
        )

        val batches = mutableListOf<GoogleHealthSyncBatchResponse>()
        val errors = mutableListOf<GoogleHealthSyncErrorResponse>()
        for (dataType in validated.dataTypes) {
            for (window in syncWindows(dataType, validated.from, validated.to)) {
                val batchExternalId = batchExternalId(
                    account.providerInstanceId,
                    dataType,
                    window.from,
                    window.to,
                )
                val existingBatch = ingestionService.findExistingBatch(
                    provider = GOOGLE_HEALTH_PROVIDER_CODE,
                    providerInstanceId = account.providerInstanceId,
                    batchExternalId = batchExternalId,
                    now = now,
                )
                if (existingBatch?.status == "processed") {
                    batches.add(cachedBatchResponse(dataType, existingBatch.id))
                    logger.info(
                        "google_health_data_type_cache_hit {} {} {} {}",
                        kv("dataType", dataType),
                        kv("batchId", existingBatch.id),
                        kv("from", window.from.toString()),
                        kv("to", window.to.toString()),
                    )
                    continue
                }

                try {
                    val fetchResult = fetchWithOneAuthRetry(
                        tokenState,
                        account,
                        cipher,
                        dataType,
                        window.from,
                        window.to,
                        validated.pageSizeFor(dataType),
                        now,
                    )
                    val normalized = normalizer.normalize(fetchResult)
                    if (normalized.records.isEmpty()) {
                        logger.info(
                            "google_health_data_type_synced {} {} {} {}",
                            kv("dataType", dataType),
                            kv("pages", fetchResult.pages.size),
                            kv("dataPoints", fetchResult.dataPoints.size),
                            kv("records", 0),
                        )
                        continue
                    }
                    val summary = ingestionService.ingestBatch(
                        IngestionBatchRequest(
                            provider = GOOGLE_HEALTH_PROVIDER_CODE,
                            providerInstanceId = account.providerInstanceId,
                            batchExternalId = batchExternalId,
                            ingestedAt = now.toString(),
                            sourcePayload = buildJsonObject {
                                put("provider", GOOGLE_HEALTH_PROVIDER_CODE)
                                put("providerInstanceId", account.providerInstanceId)
                                put("requestedFrom", window.from.toString())
                                put("requestedTo", window.to.toString())
                                put("dataType", dataType)
                                put("pages", normalized.sourcePayload["pages"] ?: JsonArray(emptyList()))
                            },
                            records = normalized.records,
                        ),
                        now = now,
                    )
                    batches.add(
                        GoogleHealthSyncBatchResponse(
                            dataType = dataType,
                            batchId = summary.batchId,
                            duplicateBatch = summary.duplicateBatch,
                            recordsReceived = summary.recordsReceived,
                            ingestionRecordsStored = summary.ingestionRecordsStored,
                            metricsCreated = summary.metricsCreated,
                            metricsSkipped = summary.metricsSkipped,
                            affectedStepSummaryDates = summary.affectedStepSummaryDates,
                        )
                    )
                    logger.info(
                        "google_health_data_type_synced {} {} {} {} {} {}",
                        kv("dataType", dataType),
                        kv("pages", fetchResult.pages.size),
                        kv("dataPoints", fetchResult.dataPoints.size),
                        kv("records", normalized.records.size),
                        kv("batchId", summary.batchId),
                        kv("duplicateBatch", summary.duplicateBatch),
                    )
                } catch (exception: Exception) {
                    if (exception is CancellationException) throw exception
                    val code = errorCode(exception)
                    logger.warn(
                        "google_health_data_type_failed {} {}",
                        kv("dataType", dataType),
                        kv("errorCode", code),
                    )
                    errors.add(
                        GoogleHealthSyncErrorResponse(
                            dataType = dataType,
                            code = code,
                            message = exception.message ?: "Google Health sync failed",
                        )
                    )
                }
            }
        }

        val status = when {
            errors.isEmpty() -> "processed"
            batches.isEmpty() -> "failed"
            else -> "partial_failed"
        }
        repository.finishSyncRun(
            runId = runId,
            status = status,
            finishedAt = now,
            errorMessage = errors.joinToString("; ") { "${it.dataType}: ${it.message}" }.ifBlank { null },
        )
        val completionLevelMessage = "google_health_sync_completed {} {} {} {}"
        val completionArgs = arrayOf(
            kv("syncRunId", runId),
            kv("status", status),
            kv("batchCount", batches.size),
            kv("errorCount", errors.size),
        )
        when (status) {
            "processed" -> logger.info(completionLevelMessage, *completionArgs)
            "partial_failed" -> logger.warn(completionLevelMessage, *completionArgs)
            else -> logger.error(completionLevelMessage, *completionArgs)
        }
        if (batches.isEmpty() && errors.isNotEmpty()) {
            val first = errors.first()
            throw UpstreamProviderException(first.code, first.message, 502)
        }

        return GoogleHealthSyncResponse(
            provider = GOOGLE_HEALTH_PROVIDER_CODE,
            providerInstanceId = account.providerInstanceId,
            requestedRange = GoogleHealthRequestedRangeResponse(
                from = validated.from.toString(),
                to = validated.to.toString(),
            ),
            batches = batches,
            errors = errors,
        )
    }

    private suspend fun freshAccessToken(
        account: ProviderOAuthAccount,
        cipher: TokenCipher,
        now: Instant,
    ): TokenState {
        val accessToken = cipher.decrypt(account.accessTokenCiphertext)
        val refreshToken = cipher.decrypt(account.refreshTokenCiphertext)
        if (account.expiresAt.isAfter(now.plusSeconds(60))) {
            return TokenState(accessToken, refreshToken)
        }
        return refreshAccessToken(account, refreshToken, cipher, now)
    }

    private suspend fun fetchWithOneAuthRetry(
        tokenState: TokenState,
        account: ProviderOAuthAccount,
        cipher: TokenCipher,
        dataType: String,
        from: Instant,
        to: Instant,
        pageSize: Int,
        now: Instant,
    ): GoogleHealthFetchResult =
        try {
            client.fetchDataPoints(tokenState.accessToken, dataType, from, to, pageSize)
        } catch (_: GoogleHealthUnauthorizedException) {
            logger.warn(
                "google_health_fetch_unauthorized_retrying {}",
                kv("dataType", dataType),
            )
            val refreshed = refreshAccessToken(account, tokenState.refreshToken, cipher, now)
            client.fetchDataPoints(refreshed.accessToken, dataType, from, to, pageSize)
        }

    private suspend fun refreshAccessToken(
        account: ProviderOAuthAccount,
        refreshToken: String,
        cipher: TokenCipher,
        now: Instant,
    ): TokenState {
        val tokens = try {
            client.refreshToken(refreshToken, now)
        } catch (exception: Exception) {
            if (exception is CancellationException) throw exception
            logger.warn(
                "google_health_token_exchange_failed {}",
                kv("errorCode", "google_health_token_refresh_failed"),
            )
            throw UpstreamProviderException(
                "google_health_token_refresh_failed",
                exception.message ?: "Google OAuth token refresh failed",
                502,
            )
        }
        val nextRefreshToken = tokens.refreshToken ?: refreshToken
        repository.updateAccessToken(
            accountId = account.id,
            accessTokenCiphertext = cipher.encrypt(tokens.accessToken),
            refreshTokenCiphertext = tokens.refreshToken?.let(cipher::encrypt),
            tokenType = tokens.tokenType,
            expiresAt = tokens.expiresAt,
            scope = tokens.scope,
            now = now,
        )
        logger.info(
            "google_health_token_refreshed {} {}",
            kv("providerInstanceId", account.providerInstanceId),
            kv("expiresAt", tokens.expiresAt.toString()),
        )
        return TokenState(tokens.accessToken, nextRefreshToken)
    }

    private fun validate(request: GoogleHealthSyncRequest, now: Instant): ValidatedSyncRequest {
        val issues = mutableListOf<ValidationIssue>()
        val from = request.from?.let { parseInstant("from", it, issues) }
        val to = request.to?.let { parseInstant("to", it, issues) }
        val resolvedFrom: Instant
        val resolvedTo: Instant
        if (from == null && to == null && issues.isEmpty()) {
            resolvedTo = now
            resolvedFrom = now.minus(Duration.ofDays(7))
        } else {
            resolvedFrom = from ?: run {
                issues.add(ValidationIssue("from", "is required when to is provided"))
                now
            }
            resolvedTo = to ?: run {
                issues.add(ValidationIssue("to", "is required when from is provided"))
                now
            }
        }
        if (!resolvedFrom.isBefore(resolvedTo)) {
            issues.add(ValidationIssue("from", "must be before to"))
        }
        if (Duration.between(resolvedFrom, resolvedTo) > Duration.ofDays(31)) {
            issues.add(ValidationIssue("to", "range must not exceed 31 days"))
        }

        val dataTypes = request.dataTypes?.takeIf { it.isNotEmpty() } ?: GOOGLE_HEALTH_DEFAULT_DATA_TYPES
        dataTypes.forEachIndexed { index, dataType ->
            if (dataType !in GOOGLE_HEALTH_DEFAULT_DATA_TYPES) {
                issues.add(ValidationIssue("dataTypes[$index]", "unsupported Google Health data type"))
            }
        }
        val pageSize = request.pageSize ?: 10000
        if (pageSize <= 0) {
            issues.add(ValidationIssue("pageSize", "must be greater than 0"))
        }
        if (issues.isNotEmpty()) throw RequestValidationException(issues)
        return ValidatedSyncRequest(
            from = resolvedFrom,
            to = resolvedTo,
            dataTypes = dataTypes.distinct(),
            pageSize = pageSize,
        )
    }

    private fun parseInstant(field: String, value: String, issues: MutableList<ValidationIssue>): Instant? =
        runCatching { Instant.parse(value) }.getOrElse {
            issues.add(ValidationIssue(field, "must be an ISO-8601 instant"))
            null
        }

    private fun batchExternalId(providerInstanceId: String, dataType: String, from: Instant, to: Instant): String =
        "google-health:$providerInstanceId:$dataType:$from:$to"

    private fun cachedBatchResponse(dataType: String, batchId: Int): GoogleHealthSyncBatchResponse =
        GoogleHealthSyncBatchResponse(
            dataType = dataType,
            batchId = batchId,
            duplicateBatch = true,
            recordsReceived = 0,
            ingestionRecordsStored = 0,
            metricsCreated = MetricCreatedCountsResponse(0, 0, 0, 0, 0),
            metricsSkipped = MetricSkippedCountsResponse(duplicates = 0),
            affectedStepSummaryDates = emptyList(),
        )

    private fun syncWindows(dataType: String, from: Instant, to: Instant): List<SyncWindow> {
        val windowSize = if (dataType == "heart-rate") Duration.ofDays(1) else Duration.between(from, to)
        val windows = mutableListOf<SyncWindow>()
        var windowFrom = from
        while (windowFrom.isBefore(to)) {
            val windowTo = listOf(windowFrom.plus(windowSize), to).minOrNull()!!
            windows.add(SyncWindow(windowFrom, windowTo))
            windowFrom = windowTo
        }
        return windows
    }

    private fun errorCode(throwable: Throwable): String =
        when (throwable) {
            is GoogleHealthHttpException -> throwable.code
            is UpstreamProviderException -> throwable.code
            else -> "google_health_sync_failed"
        }

    private data class ValidatedSyncRequest(
        val from: Instant,
        val to: Instant,
        val dataTypes: List<String>,
        val pageSize: Int,
    ) {
        fun pageSizeFor(dataType: String): Int =
            if (dataType == "sleep") pageSize.coerceAtMost(25) else pageSize.coerceAtMost(10000)
    }

    private data class TokenState(
        val accessToken: String,
        val refreshToken: String,
    )

    private data class SyncWindow(
        val from: Instant,
        val to: Instant,
    )
}

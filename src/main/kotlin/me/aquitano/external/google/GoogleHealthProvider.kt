package me.aquitano.external.google

import io.ktor.http.URLBuilder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import me.aquitano.health.api.dto.IngestionBatchRequest
import me.aquitano.health.application.IngestionService
import me.aquitano.health.domain.ConflictException
import me.aquitano.health.domain.HealthProviderDescriptor
import me.aquitano.health.domain.HealthProvider
import me.aquitano.health.domain.MetricCreatedCounts
import me.aquitano.health.domain.ProviderAuthType
import me.aquitano.health.domain.ProviderConnection
import me.aquitano.health.domain.ProviderSyncBatch
import me.aquitano.health.domain.ProviderSyncError
import me.aquitano.health.domain.ProviderSyncRequest
import me.aquitano.health.domain.ProviderSyncSummary
import me.aquitano.health.domain.ProviderWorkflowEndpoints
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ServerConfigurationException
import me.aquitano.health.domain.UpstreamProviderException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
import me.aquitano.health.infrastructure.config.GoogleHealthConfig
import me.aquitano.health.infrastructure.repositories.ProviderOAuthAccount
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import me.aquitano.health.infrastructure.security.TokenCipher
import net.logstash.logback.argument.StructuredArguments.kv
import org.slf4j.LoggerFactory
import java.time.Duration
import java.time.Instant
import java.util.concurrent.CancellationException

private val logger = LoggerFactory.getLogger(GoogleHealthProvider::class.java)

class GoogleHealthProvider(
    private val config: GoogleHealthConfig,
    private val repository: ProviderOAuthRepository,
    private val client: GoogleHealthClient,
    private val normalizer: GoogleHealthNormalizer,
    private val ingestionService: IngestionService,
) : HealthProvider {

    override val providerCode: String = GOOGLE_HEALTH_PROVIDER_CODE
    override val descriptor: HealthProviderDescriptor = HealthProviderDescriptor(
        providerCode = "google-health",
        displayName = "Google Health",
        authType = ProviderAuthType.OAUTH,
        requiresAuthentication = true,
        supportedDataTypes = GOOGLE_HEALTH_DEFAULT_DATA_TYPES,
        defaultDataTypes = GOOGLE_HEALTH_DEFAULT_DATA_TYPES,
        maxSyncRangeDays = 31,
        supportsPageSize = true,
        workflowEndpoints = ProviderWorkflowEndpoints(
            oauthStart = "/api/v1/providers/google-health/oauth/start",
            oauthCallback = "/api/v1/providers/google-health/oauth/callback",
            sync = "/api/v1/providers/google-health/sync",
        ),
        aliases = listOf(GOOGLE_HEALTH_PROVIDER_CODE),
    )
    override val defaultProviderInstanceId: String = "google-health-me"

    override fun isConfigured(): Boolean = configurationIssues().isEmpty()

    override fun getAuthUrl(state: String): String {
        requireConfigured()
        return URLBuilder(config.oauthAuthUrl).apply {
            parameters.append("client_id", config.clientId)
            parameters.append("redirect_uri", config.redirectUri)
            parameters.append("response_type", "code")
            parameters.append("scope", GOOGLE_HEALTH_SCOPES.joinToString(" "))
            parameters.append("state", state)
            parameters.append("access_type", "offline")
            parameters.append("prompt", "consent")
        }.buildString()
    }

    override suspend fun connect(code: String, now: Instant): ProviderConnection {
        requireConfigured()
        val tokens = providerCall(
            fallbackCode = "google_health_token_exchange_failed",
            fallbackMessage = "Google OAuth token exchange failed",
        ) {
            client.exchangeCode(code, now)
        }
        val refreshToken = tokens.refreshToken
            ?: throw UpstreamProviderException(
                code = "google_health_missing_refresh_token",
                message = "Google OAuth response did not include a refresh token; start OAuth again with prompt=consent",
                statusCode = 502,
            )
        val cipher = TokenCipher(config.tokenEncryptionKey)
        repository.upsertAccount(
            providerCode = GOOGLE_HEALTH_PROVIDER_CODE,
            providerUserId = defaultProviderInstanceId,
            providerInstanceId = defaultProviderInstanceId,
            accessTokenCiphertext = cipher.encrypt(tokens.accessToken),
            refreshTokenCiphertext = cipher.encrypt(refreshToken),
            tokenType = tokens.tokenType,
            expiresAt = tokens.expiresAt,
            scope = tokens.scope,
            now = now,
        )
        logger.info(
            "provider_oauth_connected {} {} {} {}",
            kv("provider", GOOGLE_HEALTH_PROVIDER_CODE),
            kv("providerInstanceId", defaultProviderInstanceId),
            kv("expiresAt", tokens.expiresAt.toString()),
            kv("scopeCount", tokens.scope.split(" ").count { it.isNotBlank() }),
        )
        return ProviderConnection(
            providerCode = GOOGLE_HEALTH_PROVIDER_CODE,
            providerInstanceId = defaultProviderInstanceId,
            connected = true,
        )
    }

    override suspend fun sync(
        request: ProviderSyncRequest,
        now: Instant,
    ): ProviderSyncSummary {
        val validated = validate(request)
        val account = repository.latestAccount(GOOGLE_HEALTH_PROVIDER_CODE)
            ?: throw ConflictException(
                "google_health_not_connected",
                "Google Health is not connected",
            )
        val providerInstanceId = validated.providerInstanceId ?: account.providerInstanceId
        val cipher = TokenCipher(config.tokenEncryptionKey)
        val tokenState = freshAccessToken(account, cipher, now)

        val runId = repository.startSyncRun(
            providerCode = GOOGLE_HEALTH_PROVIDER_CODE,
            providerInstanceId = providerInstanceId,
            requestedFrom = validated.from,
            requestedTo = validated.to,
            startedAt = now,
        )
        logger.info(
            "provider_sync_started {} {} {} {} {} {}",
            kv("provider", GOOGLE_HEALTH_PROVIDER_CODE),
            kv("providerInstanceId", providerInstanceId),
            kv("from", validated.from.toString()),
            kv("to", validated.to.toString()),
            kv("dataTypes", validated.dataTypes),
            kv("pageSize", validated.pageSize),
        )

        val batches = mutableListOf<ProviderSyncBatch>()
        val errors = mutableListOf<ProviderSyncError>()
        for (dataType in validated.dataTypes) {
            for (window in syncWindows(dataType, validated.from, validated.to)) {
                val batchExternalId = batchExternalId(providerInstanceId, dataType, window.from, window.to)
                val existingBatch = ingestionService.findExistingBatch(
                    provider = GOOGLE_HEALTH_PROVIDER_CODE,
                    providerInstanceId = providerInstanceId,
                    batchExternalId = batchExternalId,
                    now = now,
                )
                if (existingBatch?.status == "processed") {
                    batches.add(cachedBatchResponse(dataType, existingBatch.id))
                    logger.info(
                        "provider_sync_cache_hit {} {} {} {}",
                        kv("provider", GOOGLE_HEALTH_PROVIDER_CODE),
                        kv("dataType", dataType),
                        kv("batchId", existingBatch.id),
                        kv("from", window.from.toString()),
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
                            "provider_data_type_synced {} {} {} {}",
                            kv("provider", GOOGLE_HEALTH_PROVIDER_CODE),
                            kv("dataType", dataType),
                            kv("pages", fetchResult.pages.size),
                            kv("records", 0),
                        )
                        continue
                    }
                    val summary = ingestionService.ingestBatch(
                        IngestionBatchRequest(
                            provider = GOOGLE_HEALTH_PROVIDER_CODE,
                            providerInstanceId = providerInstanceId,
                            batchExternalId = batchExternalId,
                            ingestedAt = now.toString(),
                            sourcePayload = buildJsonObject {
                                put("provider", GOOGLE_HEALTH_PROVIDER_CODE)
                                put("providerInstanceId", providerInstanceId)
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
                        ProviderSyncBatch(
                            dataType = dataType,
                            batchId = summary.batchId,
                            duplicateBatch = summary.duplicateBatch,
                            recordsReceived = summary.recordsReceived,
                            ingestionRecordsStored = summary.ingestionRecordsStored,
                            metricsCreated = MetricCreatedCounts(
                                stepSamples = summary.metricsCreated.stepSamples,
                                sleepSessions = summary.metricsCreated.sleepSessions,
                                sleepStages = summary.metricsCreated.sleepStages,
                                bodyMeasurements = summary.metricsCreated.bodyMeasurements,
                                heartRateSamples = summary.metricsCreated.heartRateSamples,
                            ),
                            duplicateMetricsSkipped = summary.metricsSkipped.duplicates,
                            affectedStepSummaryDates = summary.affectedStepSummaryDates,
                        )
                    )
                    logger.info(
                        "provider_data_type_synced {} {} {} {} {} {}",
                        kv("provider", GOOGLE_HEALTH_PROVIDER_CODE),
                        kv("dataType", dataType),
                        kv("pages", fetchResult.pages.size),
                        kv("records", normalized.records.size),
                        kv("batchId", summary.batchId),
                        kv("duplicateBatch", summary.duplicateBatch),
                    )
                } catch (exception: Exception) {
                    if (exception is CancellationException) throw exception
                    val code = errorCode(exception)
                    logger.warn(
                        "provider_data_type_failed {} {} {}",
                        kv("provider", GOOGLE_HEALTH_PROVIDER_CODE),
                        kv("dataType", dataType),
                        kv("errorCode", code),
                    )
                    errors.add(
                        ProviderSyncError(
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
        val completionMessage = "provider_sync_completed {} {} {} {} {}"
        val completionArgs = arrayOf(
            kv("provider", GOOGLE_HEALTH_PROVIDER_CODE),
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
            providerCode = GOOGLE_HEALTH_PROVIDER_CODE,
            providerInstanceId = providerInstanceId,
            requestedFrom = validated.from,
            requestedTo = validated.to,
            status = status,
            batches = batches,
            errors = errors,
        )
    }

    private fun validate(request: ProviderSyncRequest): ValidatedSyncRequest {
        val issues = mutableListOf<ValidationIssue>()
        val dataTypes = request.dataTypes?.takeIf { it.isNotEmpty() } ?: GOOGLE_HEALTH_DEFAULT_DATA_TYPES
        dataTypes.forEachIndexed { index, dataType ->
            if (dataType !in GOOGLE_HEALTH_DEFAULT_DATA_TYPES) {
                issues.add(
                    ValidationIssue(
                        field = "dataTypes[$index]",
                        code = ValidationIssueCodes.UnsupportedValue,
                        message = "unsupported Google Health data type",
                    )
                )
            }
        }
        val pageSize = request.pageSize ?: 10000
        if (issues.isNotEmpty()) throw RequestValidationException(issues)
        return ValidatedSyncRequest(
            providerInstanceId = request.providerInstanceId,
            from = request.from,
            to = request.to,
            dataTypes = dataTypes.distinct(),
            pageSize = pageSize,
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
                "provider_token_refresh_failed {} {}",
                kv("provider", GOOGLE_HEALTH_PROVIDER_CODE),
                kv("errorCode", "google_health_token_refresh_failed"),
            )
            throw UpstreamProviderException(
                code = "google_health_token_refresh_failed",
                message = exception.message ?: "Google OAuth token refresh failed",
                statusCode = 502,
                cause = exception,
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
            "provider_token_refreshed {} {} {}",
            kv("provider", GOOGLE_HEALTH_PROVIDER_CODE),
            kv("providerInstanceId", account.providerInstanceId),
            kv("expiresAt", tokens.expiresAt.toString()),
        )
        return TokenState(tokens.accessToken, nextRefreshToken)
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
                "provider_fetch_unauthorized_retrying {} {}",
                kv("provider", GOOGLE_HEALTH_PROVIDER_CODE),
                kv("dataType", dataType),
            )
            val refreshed = refreshAccessToken(account, tokenState.refreshToken, cipher, now)
            client.fetchDataPoints(refreshed.accessToken, dataType, from, to, pageSize)
        }

    private fun requireConfigured() {
        val issues = configurationIssues()
        if (issues.isNotEmpty()) {
            throw ServerConfigurationException(
                code = "google_health_not_configured",
                publicMessage = "Provider is not configured",
                details = issues,
            )
        }
    }

    private fun configurationIssues(): List<ValidationIssue> =
        buildList {
            if (config.clientId.isBlank()) add(ValidationIssue("googleHealth.clientId"))
            if (config.clientSecret.isBlank()) add(ValidationIssue("googleHealth.clientSecret"))
            if (config.redirectUri.isBlank()) add(ValidationIssue("googleHealth.redirectUri"))
            if (config.tokenEncryptionKey.isBlank()) add(ValidationIssue("googleHealth.tokenEncryptionKey"))
        }

    private suspend fun <T> providerCall(
        fallbackCode: String,
        fallbackMessage: String,
        block: suspend () -> T,
    ): T =
        try {
            block()
        } catch (throwable: GoogleHealthHttpException) {
            logger.warn(
                "provider_token_exchange_failed {} {}",
                kv("provider", GOOGLE_HEALTH_PROVIDER_CODE),
                kv("errorCode", throwable.code),
            )
            throw UpstreamProviderException(
                code = throwable.code,
                message = throwable.message ?: fallbackMessage,
                statusCode = 502,
                cause = throwable,
            )
        } catch (throwable: GoogleHealthUnauthorizedException) {
            logger.warn(
                "provider_token_exchange_failed {} {}",
                kv("provider", GOOGLE_HEALTH_PROVIDER_CODE),
                kv("errorCode", fallbackCode),
            )
            throw UpstreamProviderException(
                code = fallbackCode,
                message = throwable.message ?: fallbackMessage,
                statusCode = 502,
                cause = throwable,
            )
        }

    private fun batchExternalId(providerInstanceId: String, dataType: String, from: Instant, to: Instant): String =
        "google-health:$providerInstanceId:$dataType:$from:$to"

    private fun cachedBatchResponse(dataType: String, batchId: Int): ProviderSyncBatch =
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
        val providerInstanceId: String?,
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

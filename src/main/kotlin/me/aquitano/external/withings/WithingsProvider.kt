package me.aquitano.external.withings

import io.ktor.http.*
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import me.aquitano.health.api.dto.IngestionBatchRequest
import me.aquitano.health.application.IngestionService
import me.aquitano.health.domain.*
import me.aquitano.health.infrastructure.config.WithingsConfig
import me.aquitano.health.infrastructure.repositories.ACCOUNT_STATUS_NEEDS_REAUTH
import me.aquitano.health.infrastructure.repositories.ProviderOAuthAccount
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import me.aquitano.health.infrastructure.security.TokenCipher
import net.logstash.logback.argument.StructuredArguments.kv
import org.slf4j.LoggerFactory
import java.time.Instant
import java.util.concurrent.CancellationException

private val logger = LoggerFactory.getLogger(WithingsProvider::class.java)

class WithingsProvider(
    private val config: WithingsConfig,
    private val repository: ProviderOAuthRepository,
    private val client: WithingsClient,
    private val normalizer: WithingsNormalizer,
    private val ingestionService: IngestionService,
) : HealthProvider {
    override val providerCode: String = WITHINGS_PROVIDER_CODE
    override val descriptor: HealthProviderDescriptor =
        HealthProviderDescriptor(
            providerCode = WITHINGS_PROVIDER_CODE,
            displayName = "Withings",
            authType = ProviderAuthType.OAUTH,
            requiresAuthentication = true,
            supportedDataTypes = WITHINGS_DEFAULT_DATA_TYPES,
            defaultDataTypes = WITHINGS_DEFAULT_DATA_TYPES,
            maxSyncRangeDays = 31,
            supportsPageSize = false,
            workflowEndpoints = ProviderWorkflowEndpoints(
                oauthStart = "/api/v1/providers/withings/oauth/start",
                oauthCallback = "/api/v1/providers/withings/oauth/callback",
                accounts = "/api/v1/providers/withings/accounts",
                disconnect = "/api/v1/providers/withings/accounts/{providerInstanceId}/disconnect",
                reconnect = "/api/v1/providers/withings/accounts/{providerInstanceId}/reconnect",
                sync = "/api/v1/providers/withings/sync",
            ),
        )
    override val defaultProviderInstanceId: String = "withings-me"

    override fun isConfigured(): Boolean = configurationIssues().isEmpty()

    override fun getAuthUrl(state: String): String {
        requireConfigured()
        return URLBuilder(config.oauthAuthUrl).apply {
            parameters.append("response_type", "code")
            parameters.append("client_id", config.clientId)
            parameters.append("scope", WITHINGS_SCOPES.joinToString(","))
            parameters.append("redirect_uri", config.redirectUri)
            parameters.append("state", state)
        }.buildString()
    }

    override suspend fun connect(
        code: String,
        now: Instant
    ): ProviderConnection {
        requireConfigured()
        val tokens = try {
            client.exchangeCode(code, now)
        } catch (exception: WithingsHttpException) {
            logger.warn(
                "provider_token_exchange_failed {} {}",
                kv("provider", WITHINGS_PROVIDER_CODE),
                kv("errorCode", exception.code),
            )
            throw UpstreamProviderException(
                code = exception.code,
                message = exception.message
                    ?: "Withings OAuth token exchange failed",
                statusCode = 502,
                cause = exception,
            )
        }

        val providerUserId = tokens.providerUserId.takeIf { it.isNotBlank() }
            ?: throw UpstreamProviderException(
                code = "withings_missing_userid",
                message = "Withings OAuth token response did not include userid",
                statusCode = 502,
            )
        val providerInstanceId = providerInstanceId(providerUserId)
        val cipher = TokenCipher(config.tokenEncryptionKey)
        repository.upsertAccount(
            providerCode = WITHINGS_PROVIDER_CODE,
            providerUserId = providerUserId,
            providerInstanceId = providerInstanceId,
            accessTokenCiphertext = cipher.encrypt(tokens.accessToken),
            refreshTokenCiphertext = cipher.encrypt(tokens.refreshToken),
            tokenType = tokens.tokenType,
            expiresAt = tokens.expiresAt,
            scope = tokens.scope,
            now = now,
        )
        logger.info(
            "provider_oauth_connected {} {} {} {}",
            kv("provider", WITHINGS_PROVIDER_CODE),
            kv("providerInstanceId", providerInstanceId),
            kv("expiresAt", tokens.expiresAt.toString()),
            kv("scopeCount", tokens.scope.split(",").count { it.isNotBlank() }),
        )
        return ProviderConnection(
            providerCode = WITHINGS_PROVIDER_CODE,
            providerInstanceId = providerInstanceId,
            connected = true,
        )
    }

    override suspend fun sync(
        request: ProviderSyncRequest,
        now: Instant
    ): ProviderSyncSummary {
        val validated = validate(request)
        val account = accountForSync(validated.providerInstanceId)
        val providerInstanceId = account.providerInstanceId
        val cipher = TokenCipher(config.tokenEncryptionKey)
        var tokenState = freshAccessToken(account, cipher, now)
        val runId = repository.startSyncRun(
            providerCode = WITHINGS_PROVIDER_CODE,
            providerInstanceId = providerInstanceId,
            requestedFrom = validated.from,
            requestedTo = validated.to,
            startedAt = now,
        )

        val batches = mutableListOf<ProviderSyncBatch>()
        val errors = mutableListOf<ProviderSyncError>()
        val emptyDataTypes = mutableListOf<ProviderSyncEmptyDataType>()
        for (dataType in validated.dataTypes) {
            val batchExternalId = batchExternalId(
                providerInstanceId,
                dataType,
                validated.from,
                validated.to
            )
            val existingBatch = ingestionService.findExistingBatch(
                provider = WITHINGS_PROVIDER_CODE,
                providerInstanceId = providerInstanceId,
                batchExternalId = batchExternalId,
                now = now,
            )
            if (existingBatch?.status == "processed") {
                batches.add(cachedBatchResponse(dataType, existingBatch.id))
                continue
            }

            try {
                val authResult = fetchWithOneAuthRetry(
                    tokenState = tokenState,
                    account = account,
                    cipher = cipher,
                    dataType = dataType,
                    from = validated.from,
                    to = validated.to,
                    now = now,
                )
                tokenState = authResult.tokenState
                val fetchResult = authResult.fetchResult
                val normalized = normalizer.normalize(fetchResult)
                if (normalized.records.isEmpty()) {
                    logger.info(
                        "provider_data_type_synced {} {} {} {} {}",
                        kv("provider", WITHINGS_PROVIDER_CODE),
                        kv("dataType", dataType),
                        kv("pages", fetchResult.pages.size),
                        kv("sourceRecords", fetchResult.records.size),
                        kv("normalizedRecords", 0),
                    )
                    emptyDataTypes.add(
                        ProviderSyncEmptyDataType(
                            dataType = dataType,
                            pagesFetched = fetchResult.pages.size,
                            sourceRecordsReceived = fetchResult.records.size,
                            normalizedRecords = 0,
                        )
                    )
                    continue
                }
                val summary = ingestionService.ingestBatch(
                    IngestionBatchRequest(
                        provider = WITHINGS_PROVIDER_CODE,
                        providerInstanceId = providerInstanceId,
                        batchExternalId = batchExternalId,
                        ingestedAt = now.toString(),
                        sourcePayload = buildJsonObject {
                            put("provider", WITHINGS_PROVIDER_CODE)
                            put("providerInstanceId", providerInstanceId)
                            put("requestedFrom", validated.from.toString())
                            put("requestedTo", validated.to.toString())
                            put("dataType", dataType)
                            put(
                                "pages",
                                normalized.sourcePayload["pages"] ?: JsonArray(
                                    emptyList()
                                )
                            )
                            put(
                                "records",
                                normalized.sourcePayload["records"]
                                    ?: JsonArray(emptyList())
                            )
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
                            activitySummaries = summary.metricsCreated.activitySummaries,
                            sleepSummaries = summary.metricsCreated.sleepSummaries,
                            respiratoryRateSamples = summary.metricsCreated.respiratoryRateSamples,
                            hrvSamples = summary.metricsCreated.hrvSamples,
                        ),
                        duplicateMetricsSkipped = summary.metricsSkipped.duplicates,
                        affectedStepSummaryDates = summary.affectedStepSummaryDates,
                    )
                )
            } catch (exception: Exception) {
                if (exception is CancellationException) throw exception
                val code = errorCode(exception)
                logger.warn(
                    "provider_data_type_failed {} {} {}",
                    kv("provider", WITHINGS_PROVIDER_CODE),
                    kv("dataType", dataType),
                    kv("errorCode", code),
                )
                errors.add(
                    ProviderSyncError(
                        dataType = dataType,
                        code = code,
                        message = exception.message ?: "Withings sync failed",
                    )
                )
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
            errorMessage = errors.joinToString("; ") { "${it.dataType}: ${it.message}" }
                .ifBlank { null },
        )
        if (batches.isEmpty() && errors.isNotEmpty()) {
            val first = errors.first()
            throw UpstreamProviderException(first.code, first.message, 502)
        }

        return ProviderSyncSummary(
            providerCode = WITHINGS_PROVIDER_CODE,
            providerInstanceId = providerInstanceId,
            requestedFrom = validated.from,
            requestedTo = validated.to,
            status = status,
            batches = batches,
            errors = errors,
            emptyDataTypes = emptyDataTypes,
        )
    }

    private suspend fun accountForSync(providerInstanceId: String?): ProviderOAuthAccount =
        if (providerInstanceId == null) {
            repository.latestAccount(WITHINGS_PROVIDER_CODE)
                ?: throw withingsAccountUnavailable(null)
        } else {
            repository.accountByProviderInstance(
                WITHINGS_PROVIDER_CODE,
                providerInstanceId
            )
                ?: throw withingsAccountUnavailable(providerInstanceId)
        }

    private suspend fun withingsAccountUnavailable(providerInstanceId: String?): ConflictException {
        val account = providerInstanceId?.let {
            repository.accountByProviderInstanceForStatus(
                WITHINGS_PROVIDER_CODE,
                it,
            )
        } ?: repository.accountsByProvider(WITHINGS_PROVIDER_CODE).firstOrNull {
            it.accountStatus == ACCOUNT_STATUS_NEEDS_REAUTH
        }
        if (account?.accountStatus == ACCOUNT_STATUS_NEEDS_REAUTH) {
            return ConflictException(
                "withings_needs_reauth",
                "Withings needs reconnect before syncing",
            )
        }
        return if (providerInstanceId == null) {
            ConflictException(
                "withings_not_connected",
                "Withings is not connected",
            )
        } else {
            ConflictException(
                "withings_account_not_found",
                "Withings account is not connected for providerInstanceId: $providerInstanceId",
            )
        }
    }

    private fun validate(request: ProviderSyncRequest): ValidatedSyncRequest {
        val issues = mutableListOf<ValidationIssue>()
        val dataTypes = request.dataTypes?.takeIf { it.isNotEmpty() }
            ?: WITHINGS_DEFAULT_DATA_TYPES
        dataTypes.forEachIndexed { index, dataType ->
            if (dataType !in WITHINGS_DEFAULT_DATA_TYPES) {
                issues.add(
                    ValidationIssue(
                        field = "dataTypes[$index]",
                        code = ValidationIssueCodes.UnsupportedValue,
                        message = "unsupported Withings data type",
                    )
                )
            }
        }
        if (issues.isNotEmpty()) throw RequestValidationException(issues)
        return ValidatedSyncRequest(
            providerInstanceId = request.providerInstanceId,
            from = request.from,
            to = request.to,
            dataTypes = dataTypes.distinct(),
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
            val message = exception.message ?: "Withings OAuth token refresh failed"
            if (exception.isInvalidRefreshToken()) {
                repository.markNeedsReauth(
                    accountId = account.id,
                    errorCode = "withings_needs_reauth",
                    errorMessage = message,
                    now = now,
                )
                throw ConflictException(
                    code = "withings_needs_reauth",
                    message = "Withings needs reconnect before syncing",
                    cause = exception,
                )
            }
            repository.markTokenRefreshFailed(
                accountId = account.id,
                errorCode = errorCode(exception),
                errorMessage = message,
                now = now,
            )
            throw UpstreamProviderException(
                code = "withings_token_refresh_failed",
                message = message,
                statusCode = 502,
                cause = exception,
            )
        }
        repository.updateAccessToken(
            accountId = account.id,
            accessTokenCiphertext = cipher.encrypt(tokens.accessToken),
            refreshTokenCiphertext = cipher.encrypt(tokens.refreshToken),
            tokenType = tokens.tokenType,
            expiresAt = tokens.expiresAt,
            scope = tokens.scope,
            now = now,
        )
        return TokenState(tokens.accessToken, tokens.refreshToken)
    }

    private suspend fun fetchWithOneAuthRetry(
        tokenState: TokenState,
        account: ProviderOAuthAccount,
        cipher: TokenCipher,
        dataType: String,
        from: Instant,
        to: Instant,
        now: Instant,
    ): FetchWithAuthResult =
        try {
            FetchWithAuthResult(
                fetchResult = fetchDataType(
                    tokenState.accessToken,
                    dataType,
                    from,
                    to
                ),
                tokenState = tokenState,
            )
        } catch (exception: WithingsHttpException) {
            if (exception.code != "withings_data_request_failed") throw exception
            val refreshed = refreshAccessToken(
                account,
                tokenState.refreshToken,
                cipher,
                now
            )
            FetchWithAuthResult(
                fetchResult = fetchDataType(
                    refreshed.accessToken,
                    dataType,
                    from,
                    to
                ),
                tokenState = refreshed,
            )
        }

    private suspend fun fetchDataType(
        accessToken: String,
        dataType: String,
        from: Instant,
        to: Instant,
    ): WithingsFetchResult =
        when (dataType) {
            "activity" -> client.fetchActivity(
                accessToken,
                from,
                to,
                WITHINGS_ACTIVITY_FIELDS_ALL_LISTED
            )

            "measures" -> client.fetchMeasures(
                accessToken,
                from,
                to,
                WITHINGS_MEASURE_TYPES_ALL_LISTED,
                1
            )

            "sleep-summary" -> client.fetchSleepSummary(
                accessToken,
                from,
                to,
                WITHINGS_SLEEP_SUMMARY_FIELDS_ALL_LISTED
            )

            "sleep" -> client.fetchSleep(
                accessToken,
                from,
                to,
                WITHINGS_SLEEP_FIELDS_ALL_LISTED
            )

            else -> throw WithingsHttpException(
                "withings_unsupported_data_type",
                "Unsupported Withings data type: $dataType"
            )
        }

    private fun requireConfigured() {
        val issues = configurationIssues()
        if (issues.isNotEmpty()) {
            throw ServerConfigurationException(
                code = "withings_not_configured",
                publicMessage = "Provider is not configured",
                details = issues,
            )
        }
    }

    private fun configurationIssues(): List<ValidationIssue> =
        buildList {
            if (config.clientId.isBlank()) add(ValidationIssue("withings.clientId"))
            if (config.clientSecret.isBlank()) add(ValidationIssue("withings.clientSecret"))
            if (config.redirectUri.isBlank()) add(ValidationIssue("withings.redirectUri"))
            if (config.tokenEncryptionKey.isBlank()) add(ValidationIssue("withings.tokenEncryptionKey"))
            if (config.apiBaseUrl.isBlank()) add(ValidationIssue("withings.apiBaseUrl"))
        }

    private fun providerInstanceId(providerUserId: String): String =
        "withings-$providerUserId"

    private fun batchExternalId(
        providerInstanceId: String,
        dataType: String,
        from: Instant,
        to: Instant
    ): String =
        "withings:$providerInstanceId:$dataType:$from:$to"

    private fun cachedBatchResponse(
        dataType: String,
        batchId: Int
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

    private fun errorCode(throwable: Throwable): String =
        when (throwable) {
            is WithingsHttpException -> throwable.code
            is UpstreamProviderException -> throwable.code
            else -> "withings_sync_failed"
        }

    private fun Exception.isInvalidRefreshToken(): Boolean =
        this is WithingsHttpException &&
                code == "withings_token_request_failed" &&
                providerStatus == 401

    private data class ValidatedSyncRequest(
        val providerInstanceId: String?,
        val from: Instant,
        val to: Instant,
        val dataTypes: List<String>,
    )

    private data class TokenState(
        val accessToken: String,
        val refreshToken: String,
    )

    private data class FetchWithAuthResult(
        val fetchResult: WithingsFetchResult,
        val tokenState: TokenState,
    )
}

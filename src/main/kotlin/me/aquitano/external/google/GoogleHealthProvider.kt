package me.aquitano.external.google

import io.ktor.http.*
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import me.aquitano.health.api.dto.*
import me.aquitano.health.application.IngestionService
import me.aquitano.health.domain.*
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

    override fun getAuthUrl(state: String): String {
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

    override suspend fun exchangeCode(code: String, now: Instant): ProviderAuthTokens {
        val tokens = client.exchangeCode(code, now)
        return ProviderAuthTokens(
            accessToken = tokens.accessToken,
            refreshToken = tokens.refreshToken,
            tokenType = tokens.tokenType,
            expiresAt = tokens.expiresAt,
            scope = tokens.scope,
        )
    }

    override suspend fun sync(
        providerInstanceId: String,
        from: Instant,
        to: Instant,
        now: Instant
    ): ProviderSyncSummary {
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
            requestedFrom = from,
            requestedTo = to,
            startedAt = now,
        )

        val batches = mutableListOf<ProviderSyncBatch>()
        val errors = mutableListOf<ProviderSyncError>()

        // Default data types if none specified (though standard sync should probably handle this better)
        val dataTypes = GOOGLE_HEALTH_DEFAULT_DATA_TYPES

        for (dataType in dataTypes) {
            for (window in syncWindows(dataType, from, to)) {
                val batchExternalId = batchExternalId(account.providerInstanceId, dataType, window.from, window.to)
                
                try {
                    val fetchResult = fetchWithOneAuthRetry(
                        tokenState, account, cipher, dataType, window.from, window.to, 10000, now
                    )
                    val normalized = normalizer.normalize(fetchResult)
                    
                    if (normalized.records.isNotEmpty()) {
                        val summary = ingestionService.ingestBatch(
                            IngestionBatchRequest(
                                provider = GOOGLE_HEALTH_PROVIDER_CODE,
                                providerInstanceId = account.providerInstanceId,
                                batchExternalId = batchExternalId,
                                ingestedAt = now.toString(),
                                sourcePayload = buildJsonObject {
                                    put("dataType", dataType)
                                    put("from", window.from.toString())
                                    put("to", window.to.toString())
                                },
                                records = normalized.records
                            ),
                            now = now
                        )
                        batches.add(ProviderSyncBatch(summary.batchId, summary.recordsReceived))
                    }
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    errors.add(ProviderSyncError(errorCode(e), e.message ?: "Unknown error"))
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
            errorMessage = errors.joinToString("; ") { "${it.code}: ${it.message}" }.ifBlank { null }
        )

        return ProviderSyncSummary(
            providerCode = GOOGLE_HEALTH_PROVIDER_CODE,
            providerInstanceId = account.providerInstanceId,
            status = status,
            batches = batches,
            errors = errors
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
        val tokens = client.refreshToken(refreshToken, now)
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
            val refreshed = refreshAccessToken(account, tokenState.refreshToken, cipher, now)
            client.fetchDataPoints(refreshed.accessToken, dataType, from, to, pageSize)
        }

    private fun batchExternalId(providerInstanceId: String, dataType: String, from: Instant, to: Instant): String =
        "google-health:$providerInstanceId:$dataType:$from:$to"

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

    private data class TokenState(
        val accessToken: String,
        val refreshToken: String,
    )

    private data class SyncWindow(
        val from: Instant,
        val to: Instant,
    )
}

package me.aquitano.external.withings

import io.ktor.http.URLBuilder
import me.aquitano.health.application.providersync.ProviderSyncAdapter
import me.aquitano.health.application.providersync.ProviderSyncPipeline
import me.aquitano.health.domain.*
import me.aquitano.health.infrastructure.config.WithingsConfig
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import me.aquitano.health.infrastructure.security.TokenCipher
import io.github.oshai.kotlinlogging.KotlinLogging
import me.aquitano.health.infrastructure.logging.*
import java.time.Instant

private val logger = KotlinLogging.logger {}

class WithingsProvider(
    private val config: WithingsConfig,
    private val repository: ProviderOAuthRepository,
    private val client: WithingsClient,
    normalizer: WithingsNormalizer,
    private val syncPipeline: ProviderSyncPipeline,
    private val syncAdapter: ProviderSyncAdapter = WithingsSyncAdapter(client, normalizer),
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
                oauthStart = "/api/v2/providers/withings/oauth/start",
                oauthCallback = "/api/v2/providers/withings/oauth/callback",
                accounts = "/api/v2/providers/withings/accounts",
                disconnect = "/api/v2/providers/withings/accounts/{providerInstanceId}/disconnect",
                reconnect = "/api/v2/providers/withings/accounts/{providerInstanceId}/reconnect",
                sync = "/api/v2/providers/withings/sync",
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
            logger.warnWithContext(
                "provider_token_exchange_failed",
                "provider" to WITHINGS_PROVIDER_CODE,
                "errorCode" to exception.code,
                throwable = exception,
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
        logger.infoWithContext(
            "provider_oauth_connected",
            "provider" to WITHINGS_PROVIDER_CODE,
            "providerInstanceId" to providerInstanceId,
            "expiresAt" to tokens.expiresAt,
            "scopeCount" to tokens.scope.split(",").count { it.isNotBlank() },
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
    ): ProviderSyncSummary = syncPipeline.sync(syncAdapter, request, now)

    override suspend fun sync(
        request: ProviderSyncRequest,
        now: Instant,
        progress: me.aquitano.health.application.providersync.ProviderSyncProgressSink,
    ): ProviderSyncSummary = syncPipeline.sync(syncAdapter, request, now, progress)

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

}

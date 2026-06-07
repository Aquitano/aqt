package me.aquitano.external.google

import io.ktor.http.*
import me.aquitano.health.application.IngestionService
import me.aquitano.health.application.providersync.IngestionProviderSyncPort
import me.aquitano.health.application.providersync.ProviderOAuthSyncAccountPort
import me.aquitano.health.application.providersync.ProviderOAuthSyncRunPort
import me.aquitano.health.application.providersync.ProviderSyncAdapter
import me.aquitano.health.application.providersync.ProviderSyncPipeline
import me.aquitano.health.domain.*
import me.aquitano.health.infrastructure.config.GoogleHealthConfig
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import me.aquitano.health.infrastructure.security.TokenCipher
import net.logstash.logback.argument.StructuredArguments.kv
import org.slf4j.LoggerFactory
import java.time.Instant

private val logger = LoggerFactory.getLogger(GoogleHealthProvider::class.java)

class GoogleHealthProvider(
    private val config: GoogleHealthConfig,
    private val repository: ProviderOAuthRepository,
    private val client: GoogleHealthClient,
    normalizer: GoogleHealthNormalizer,
    ingestionService: IngestionService,
    private val syncAdapter: ProviderSyncAdapter = GoogleHealthSyncAdapter(client, normalizer),
    private val syncPipeline: ProviderSyncPipeline = ProviderSyncPipeline(
        accounts = ProviderOAuthSyncAccountPort(
            repository,
            config.tokenEncryptionKey,
        ),
        runs = ProviderOAuthSyncRunPort(repository),
        ingestion = IngestionProviderSyncPort(ingestionService),
    ),
) : HealthProvider {

    override val providerCode: String = GOOGLE_HEALTH_PROVIDER_CODE
    override val descriptor: HealthProviderDescriptor =
        HealthProviderDescriptor(
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
                accounts = "/api/v1/providers/google-health/accounts",
                disconnect = "/api/v1/providers/google-health/accounts/{providerInstanceId}/disconnect",
                reconnect = "/api/v1/providers/google-health/accounts/{providerInstanceId}/reconnect",
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

    override suspend fun connect(
        code: String,
        now: Instant
    ): ProviderConnection {
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

}

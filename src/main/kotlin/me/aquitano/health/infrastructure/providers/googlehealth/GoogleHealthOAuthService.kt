package me.aquitano.health.infrastructure.providers.googlehealth

import io.ktor.http.*
import me.aquitano.health.api.dto.GoogleHealthOAuthCallbackResponse
import me.aquitano.health.api.dto.GoogleHealthOAuthStartResponse
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.UpstreamProviderException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.infrastructure.config.GoogleHealthConfig
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import me.aquitano.health.infrastructure.security.TokenCipher
import java.security.SecureRandom
import java.time.Duration
import java.time.Instant
import java.util.Base64

class GoogleHealthOAuthService(
    private val config: GoogleHealthConfig,
    private val repository: ProviderOAuthRepository,
    private val client: GoogleHealthClient,
) {
    private val random = SecureRandom()

    suspend fun start(now: Instant): GoogleHealthOAuthStartResponse {
        requireConfigured()
        val state = randomState()
        val expiresAt = now.plus(Duration.ofMinutes(10))
        repository.insertState(state, GOOGLE_HEALTH_PROVIDER_CODE, now, expiresAt)
        val url = URLBuilder(config.oauthAuthUrl).apply {
            parameters.append("client_id", config.clientId)
            parameters.append("redirect_uri", config.redirectUri)
            parameters.append("response_type", "code")
            parameters.append("scope", GOOGLE_HEALTH_SCOPES.joinToString(" "))
            parameters.append("state", state)
            parameters.append("access_type", "offline")
            parameters.append("prompt", "consent")
        }.buildString()
        return GoogleHealthOAuthStartResponse(url, expiresAt.toString())
    }

    suspend fun callback(code: String?, state: String?, error: String?, now: Instant): GoogleHealthOAuthCallbackResponse {
        requireConfigured()
        if (!error.isNullOrBlank()) {
            throw RequestValidationException(listOf(ValidationIssue("error", error)))
        }
        val authCode = code?.takeIf { it.isNotBlank() }
        val authState = state?.takeIf { it.isNotBlank() }
        if (authCode == null || authState == null) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue("code", "is required"),
                    ValidationIssue("state", "is required"),
                )
            )
        }
        val storedState = repository.consumeState(authState, GOOGLE_HEALTH_PROVIDER_CODE, now)
            ?: throw RequestValidationException(listOf(ValidationIssue("state", "is invalid")))
        if (storedState.consumedAt != null) {
            throw RequestValidationException(listOf(ValidationIssue("state", "was already used")))
        }
        if (!now.isBefore(storedState.expiresAt)) {
            throw RequestValidationException(listOf(ValidationIssue("state", "has expired")))
        }

        val tokens = providerCall("google_health_token_exchange_failed", "Google OAuth token exchange failed") {
            client.exchangeCode(authCode, now)
        }
        val refreshToken = tokens.refreshToken
            ?: throw UpstreamProviderException(
                "google_health_missing_refresh_token",
                "Google OAuth response did not include a refresh token; start OAuth again with prompt=consent",
                502,
            )
        val providerInstanceId = "google-health-me"
        val cipher = TokenCipher(config.tokenEncryptionKey)
        repository.upsertAccount(
            providerCode = GOOGLE_HEALTH_PROVIDER_CODE,
            providerUserId = providerInstanceId,
            providerInstanceId = providerInstanceId,
            accessTokenCiphertext = cipher.encrypt(tokens.accessToken),
            refreshTokenCiphertext = cipher.encrypt(refreshToken),
            tokenType = tokens.tokenType,
            expiresAt = tokens.expiresAt,
            scope = tokens.scope,
            now = now,
        )
        return GoogleHealthOAuthCallbackResponse(
            provider = GOOGLE_HEALTH_PROVIDER_CODE,
            providerInstanceId = providerInstanceId,
            connected = true,
        )
    }

    private fun requireConfigured() {
        val issues = buildList {
            if (config.clientId.isBlank()) add(ValidationIssue("googleHealth.clientId", "is required"))
            if (config.clientSecret.isBlank()) add(ValidationIssue("googleHealth.clientSecret", "is required"))
            if (config.redirectUri.isBlank()) add(ValidationIssue("googleHealth.redirectUri", "is required"))
            if (config.tokenEncryptionKey.isBlank()) add(ValidationIssue("googleHealth.tokenEncryptionKey", "is required"))
        }
        if (issues.isNotEmpty()) throw RequestValidationException(issues)
    }

    private fun randomState(): String {
        val bytes = ByteArray(32)
        random.nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    private suspend fun <T> providerCall(
        fallbackCode: String,
        fallbackMessage: String,
        block: suspend () -> T,
    ): T =
        try {
            block()
        } catch (throwable: GoogleHealthHttpException) {
            throw UpstreamProviderException(
                throwable.code,
                throwable.message ?: fallbackMessage,
                502,
            )
        } catch (throwable: GoogleHealthUnauthorizedException) {
            throw UpstreamProviderException(
                fallbackCode,
                throwable.message ?: fallbackMessage,
                502,
            )
        }
}

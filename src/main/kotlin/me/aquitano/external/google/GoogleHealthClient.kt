package me.aquitano.external.google

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.forms.submitForm
import io.ktor.http.HttpStatusCode
import io.ktor.http.isSuccess
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import me.aquitano.health.infrastructure.config.GoogleHealthConfig
import me.aquitano.health.shared.AppJson
import me.aquitano.health.shared.formParameters
import java.time.Instant

internal const val MAX_GOOGLE_HEALTH_PAGES = 500

interface GoogleHealthOAuthClient {
    suspend fun exchangeCode(code: String, now: Instant): GoogleHealthTokenSet
    suspend fun refreshToken(refreshToken: String, now: Instant): GoogleHealthTokenSet
}

interface GoogleHealthClient : GoogleHealthOAuthClient {
    suspend fun fetchDataPoints(
        accessToken: String,
        dataType: String,
        from: Instant,
        to: Instant,
        pageSize: Int,
    ): GoogleHealthFetchResult
}

class KtorGoogleHealthOAuthClient(
    private val httpClient: HttpClient,
    private val config: GoogleHealthConfig,
) : GoogleHealthOAuthClient {
    override suspend fun exchangeCode(code: String, now: Instant): GoogleHealthTokenSet {
        val response = httpClient.submitForm(
            url = config.oauthTokenUrl,
            formParameters = formParameters(
                "client_id" to config.clientId,
                "client_secret" to config.clientSecret,
                "code" to code,
                "grant_type" to "authorization_code",
                "redirect_uri" to config.redirectUri,
            ),
        )
        return parseTokenResponse(response.status, response.body(), now, existingRefreshToken = null)
    }

    override suspend fun refreshToken(refreshToken: String, now: Instant): GoogleHealthTokenSet {
        val response = httpClient.submitForm(
            url = config.oauthTokenUrl,
            formParameters = formParameters(
                "client_id" to config.clientId,
                "client_secret" to config.clientSecret,
                "refresh_token" to refreshToken,
                "grant_type" to "refresh_token",
            ),
        )
        return parseTokenResponse(response.status, response.body(), now, existingRefreshToken = refreshToken)
    }

    private fun parseTokenResponse(
        status: HttpStatusCode,
        text: String,
        now: Instant,
        existingRefreshToken: String?,
    ): GoogleHealthTokenSet {
        if (!status.isSuccess()) {
            val code = if (existingRefreshToken == null) {
                "google_health_token_exchange_failed"
            } else {
                "google_health_token_refresh_failed"
            }
            throw GoogleHealthHttpException(code, "Google OAuth token request failed with ${status.value}")
        }
        val body = AppJson.parseToJsonElement(text).jsonObject
        val accessToken = body.stringOrNull("access_token")
            ?: throw GoogleHealthHttpException("google_health_token_exchange_failed", "Google OAuth token response did not include access_token")
        val refreshToken = body.stringOrNull("refresh_token") ?: existingRefreshToken
        val tokenType = body.stringOrNull("token_type") ?: "Bearer"
        val expiresIn = body["expires_in"]?.jsonPrimitive?.longOrNull ?: 3600L
        val scope = body.stringOrNull("scope") ?: GOOGLE_HEALTH_SCOPES.joinToString(" ")
        return GoogleHealthTokenSet(
            accessToken = accessToken,
            refreshToken = refreshToken,
            tokenType = tokenType,
            expiresAt = now.plusSeconds(expiresIn),
            scope = scope,
        )
    }

    private fun JsonObject.stringOrNull(key: String): String? =
        this[key]?.jsonPrimitive?.contentOrNull
}

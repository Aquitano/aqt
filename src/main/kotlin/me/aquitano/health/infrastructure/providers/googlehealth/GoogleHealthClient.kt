package me.aquitano.health.infrastructure.providers.googlehealth

import io.ktor.client.*
import io.ktor.client.call.*
import io.ktor.client.request.*
import io.ktor.client.request.forms.*
import io.ktor.http.*
import kotlinx.serialization.json.*
import me.aquitano.health.infrastructure.config.GoogleHealthConfig
import me.aquitano.health.shared.AppJson
import net.logstash.logback.argument.StructuredArguments.kv
import org.slf4j.LoggerFactory
import java.time.Instant

private const val MAX_GOOGLE_HEALTH_PAGES = 500
private const val GOOGLE_HEALTH_PAGE_PROGRESS_INTERVAL = 25
private val logger = LoggerFactory.getLogger(KtorGoogleHealthClient::class.java)

interface GoogleHealthClient {
    suspend fun exchangeCode(code: String, now: Instant): GoogleHealthTokenSet
    suspend fun refreshToken(refreshToken: String, now: Instant): GoogleHealthTokenSet
    suspend fun fetchDataPoints(
        accessToken: String,
        dataType: String,
        from: Instant,
        to: Instant,
        pageSize: Int,
    ): GoogleHealthFetchResult
}

class KtorGoogleHealthClient(
    private val httpClient: HttpClient,
    private val config: GoogleHealthConfig,
) : GoogleHealthClient {
    override suspend fun exchangeCode(code: String, now: Instant): GoogleHealthTokenSet {
        val response = httpClient.submitForm(
            url = config.oauthTokenUrl,
            formParameters = parameters {
                append("client_id", config.clientId)
                append("client_secret", config.clientSecret)
                append("code", code)
                append("grant_type", "authorization_code")
                append("redirect_uri", config.redirectUri)
            },
        )
        return parseTokenResponse(response.status, response.body(), now, existingRefreshToken = null)
    }

    override suspend fun refreshToken(refreshToken: String, now: Instant): GoogleHealthTokenSet {
        val response = httpClient.submitForm(
            url = config.oauthTokenUrl,
            formParameters = parameters {
                append("client_id", config.clientId)
                append("client_secret", config.clientSecret)
                append("refresh_token", refreshToken)
                append("grant_type", "refresh_token")
            },
        )
        return parseTokenResponse(response.status, response.body(), now, existingRefreshToken = refreshToken)
    }

    override suspend fun fetchDataPoints(
        accessToken: String,
        dataType: String,
        from: Instant,
        to: Instant,
        pageSize: Int,
    ): GoogleHealthFetchResult =
        runCatching {
            fetchDataPoints(accessToken, dataType, from, to, pageSize, reconcile = true)
        }.recoverCatching { throwable ->
            if (throwable is GoogleHealthHttpException && throwable.code == "google_health_reconcile_unavailable") {
                fetchDataPoints(accessToken, dataType, from, to, pageSize, reconcile = false)
            } else {
                throw throwable
            }
        }.getOrThrow()

    private suspend fun fetchDataPoints(
        accessToken: String,
        dataType: String,
        from: Instant,
        to: Instant,
        pageSize: Int,
        reconcile: Boolean,
    ): GoogleHealthFetchResult {
        val pages = mutableListOf<GoogleHealthPage>()
        val dataPoints = mutableListOf<JsonObject>()
        val seenPageTokens = mutableSetOf<String>()
        var pageToken: String? = null
        var pageIndex = 0
        do {
            if (pageIndex >= MAX_GOOGLE_HEALTH_PAGES) {
                throw GoogleHealthHttpException(
                    "google_health_page_limit_exceeded",
                    "Google Health $dataType pagination exceeded $MAX_GOOGLE_HEALTH_PAGES pages",
                )
            }
            val suffix = if (reconcile) "/dataPoints:reconcile" else "/dataPoints"
            val response = httpClient.get(
                "${config.apiBaseUrl.trimEnd('/')}/v4/users/me/dataTypes/$dataType$suffix"
            ) {
                bearerAuth(accessToken)
                accept(ContentType.Application.Json)
                parameter("pageSize", pageSize)
                parameter("filter", filterFor(dataType, from, to))
                pageToken?.let { parameter("pageToken", it) }
                if (reconcile) {
                    parameter("dataSourceFamily", "users/me/dataSourceFamilies/all-sources")
                }
            }
            val text = response.body<String>()
            if (response.status == HttpStatusCode.Unauthorized) {
                throw GoogleHealthUnauthorizedException("Google Health access token is unauthorized")
            }
            if (reconcile && response.status in listOf(HttpStatusCode.BadRequest, HttpStatusCode.NotFound, HttpStatusCode.MethodNotAllowed)) {
                throw GoogleHealthHttpException("google_health_reconcile_unavailable", "Google Health reconcile is unavailable for $dataType")
            }
            if (response.status.value == 429 || response.status.value >= 500) {
                throw GoogleHealthHttpException("google_health_upstream_failed", "Google Health $dataType request failed with ${response.status.value}")
            }
            if (!response.status.isSuccess()) {
                throw GoogleHealthHttpException("google_health_upstream_failed", "Google Health $dataType request failed with ${response.status.value}")
            }

            val body = AppJson.parseToJsonElement(text).jsonObject
            pages.add(GoogleHealthPage(dataType, pageIndex, body))
            body["dataPoints"]?.jsonArray?.forEach { element ->
                (element as? JsonObject)?.let(dataPoints::add)
            }
            pageIndex += 1
            if (pageIndex == 1 || pageIndex % GOOGLE_HEALTH_PAGE_PROGRESS_INTERVAL == 0) {
                logger.info(
                    "google_health_page_fetched {} {} {} {}",
                    kv("dataType", dataType),
                    kv("pages", pageIndex),
                    kv("dataPoints", dataPoints.size),
                    kv("reconcile", reconcile),
                )
            }
            val nextPageToken = body.stringOrNull("nextPageToken")?.takeIf { it.isNotBlank() }
            if (nextPageToken != null && !seenPageTokens.add(nextPageToken)) {
                throw GoogleHealthHttpException(
                    "google_health_pagination_loop",
                    "Google Health $dataType returned a repeated page token after $pageIndex pages",
                )
            }
            pageToken = nextPageToken
        } while (pageToken != null)

        return GoogleHealthFetchResult(dataType, pages, dataPoints)
    }

    private fun parseTokenResponse(
        status: HttpStatusCode,
        text: String,
        now: Instant,
        existingRefreshToken: String?,
    ): GoogleHealthTokenSet {
        if (!status.isSuccess()) {
            val code = if (existingRefreshToken == null) "google_health_token_exchange_failed" else "google_health_token_refresh_failed"
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

    private fun filterFor(dataType: String, from: Instant, to: Instant): String =
        when (dataType) {
            "steps" -> """steps.interval.start_time >= "$from" AND steps.interval.start_time < "$to""""
            "sleep" -> """sleep.interval.end_time >= "$from" AND sleep.interval.end_time < "$to""""
            "heart-rate" -> """heart_rate.sample_time.physical_time >= "$from" AND heart_rate.sample_time.physical_time < "$to""""
            "weight" -> """weight.sample_time.physical_time >= "$from" AND weight.sample_time.physical_time < "$to""""
            "body-fat" -> """body_fat.sample_time.physical_time >= "$from" AND body_fat.sample_time.physical_time < "$to""""
            else -> throw GoogleHealthHttpException("google_health_unsupported_data_type", "Unsupported Google Health data type: $dataType")
        }

    private fun JsonObject.stringOrNull(key: String): String? =
        this[key]?.jsonPrimitive?.contentOrNull
}

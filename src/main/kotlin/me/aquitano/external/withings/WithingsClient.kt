package me.aquitano.external.withings

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.header
import io.ktor.client.request.forms.submitForm
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.isSuccess
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import me.aquitano.health.infrastructure.config.WithingsConfig
import me.aquitano.health.shared.AppJson
import me.aquitano.health.shared.formParameters
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

interface WithingsOAuthClient {
    suspend fun exchangeCode(code: String, now: Instant): WithingsTokenSet
    suspend fun refreshToken(refreshToken: String, now: Instant): WithingsTokenSet
}

interface WithingsClient : WithingsOAuthClient {
    suspend fun fetchMeasures(
        accessToken: String,
        from: Instant,
        to: Instant,
        measureTypes: List<Int>,
        category: Int,
    ): WithingsFetchResult

    suspend fun fetchActivity(
        accessToken: String,
        from: Instant,
        to: Instant,
        dataFields: List<String>,
    ): WithingsFetchResult

    suspend fun fetchSleep(
        accessToken: String,
        from: Instant,
        to: Instant,
        dataFields: List<String>,
        measureTypes: List<Int>,
    ): WithingsFetchResult

    suspend fun fetchSleepSummary(
        accessToken: String,
        from: Instant,
        to: Instant,
        dataFields: List<String>,
    ): WithingsFetchResult
}

internal const val MAX_WITHINGS_PAGES = 500

class KtorWithingsClient(
    private val httpClient: HttpClient,
    private val config: WithingsConfig,
) : WithingsClient {
    override suspend fun exchangeCode(code: String, now: Instant): WithingsTokenSet {
        val nonce = getNonce(now)
        val action = "requesttoken"
        val response = httpClient.submitForm(
            url = config.oauthTokenUrl,
            formParameters = formParameters(
                "action" to action,
                "grant_type" to "authorization_code",
                "client_id" to config.clientId,
                "code" to code,
                "redirect_uri" to config.redirectUri,
                "nonce" to nonce,
                "signature" to sign(
                    mapOf(
                        "action" to action,
                        "client_id" to config.clientId,
                        "nonce" to nonce,
                    )
                ),
            ),
        )
        return parseTokenResponse(
            status = response.status,
            text = response.body(),
            now = now,
            existingRefreshToken = null,
            requireUserId = true,
        )
    }

    override suspend fun refreshToken(refreshToken: String, now: Instant): WithingsTokenSet {
        val nonce = getNonce(now)
        val action = "requesttoken"
        val response = httpClient.submitForm(
            url = config.oauthTokenUrl,
            formParameters = formParameters(
                "action" to action,
                "grant_type" to "refresh_token",
                "client_id" to config.clientId,
                "refresh_token" to refreshToken,
                "nonce" to nonce,
                "signature" to sign(
                    mapOf(
                        "action" to action,
                        "client_id" to config.clientId,
                        "nonce" to nonce,
                    )
                ),
            ),
        )
        return parseTokenResponse(
            status = response.status,
            text = response.body(),
            now = now,
            existingRefreshToken = refreshToken,
            requireUserId = false,
        )
    }

    private suspend fun getNonce(now: Instant): String {
        val action = "getnonce"
        val timestamp = now.epochSecond.toString()
        val response = httpClient.submitForm(
            url = signatureEndpoint(),
            formParameters = formParameters(
                "action" to action,
                "client_id" to config.clientId,
                "timestamp" to timestamp,
                "signature" to sign(
                    mapOf(
                        "action" to action,
                        "client_id" to config.clientId,
                        "timestamp" to timestamp,
                    )
                ),
            ),
        )
        if (!response.status.isSuccess()) {
            throw WithingsHttpException(
                "withings_nonce_request_failed",
                "Withings nonce request failed with ${response.status.value}",
            )
        }

        val payload = AppJson.parseToJsonElement(response.body<String>()).jsonObject
        val withingsStatus = payload["status"]?.jsonPrimitive?.intOrNull
        if (withingsStatus != 0) {
            throw WithingsHttpException(
                "withings_nonce_request_failed",
                "Withings nonce request failed with status ${withingsStatus ?: "missing"}",
            )
        }
        return payload["body"]?.jsonObject?.stringOrNull("nonce")
            ?: throw WithingsHttpException("withings_nonce_request_failed", "Withings nonce response did not include nonce")
    }

    override suspend fun fetchMeasures(
        accessToken: String,
        from: Instant,
        to: Instant,
        measureTypes: List<Int>,
        category: Int,
    ): WithingsFetchResult =
        fetchPaged(
            accessToken = accessToken,
            dataType = "measures",
            endpoint = measureEndpoint(),
            action = "getmeas",
            recordsKey = "measuregrps",
            baseParameters = listOf(
                "meastypes" to measureTypes.joinToString(","),
                "category" to category.toString(),
                "startdate" to from.epochSecond.toString(),
                "enddate" to to.epochSecond.toString(),
            ),
        )

    override suspend fun fetchActivity(
        accessToken: String,
        from: Instant,
        to: Instant,
        dataFields: List<String>,
    ): WithingsFetchResult {
        val (startYmd, endYmd) = ymdRange(from, to)
        return fetchPaged(
            accessToken = accessToken,
            dataType = "activity",
            endpoint = measureEndpoint(),
            action = "getactivity",
            recordsKey = "activities",
            baseParameters = listOf(
                "startdateymd" to startYmd.toString(),
                "enddateymd" to endYmd.toString(),
                "data_fields" to dataFields.joinToString(","),
            ),
        )
    }

    override suspend fun fetchSleep(
        accessToken: String,
        from: Instant,
        to: Instant,
        dataFields: List<String>,
        measureTypes: List<Int>,
    ): WithingsFetchResult {
        val results = sleepWindows(from, to).map { window ->
            fetchPaged(
                accessToken = accessToken,
                dataType = "sleep",
                endpoint = sleepEndpoint(),
                action = "get",
                recordsKey = "series",
                baseParameters = buildList {
                    add("startdate" to window.first.epochSecond.toString())
                    add("enddate" to window.second.epochSecond.toString())
                    add("data_fields" to dataFields.joinToString(","))
                    if (measureTypes.isNotEmpty()) add("meastypes" to measureTypes.joinToString(","))
                },
            )
        }
        return WithingsFetchResult(
            dataType = "sleep",
            pages = results.flatMap { it.pages },
            records = results.flatMap { it.records },
        )
    }

    override suspend fun fetchSleepSummary(
        accessToken: String,
        from: Instant,
        to: Instant,
        dataFields: List<String>,
    ): WithingsFetchResult {
        val (startYmd, endYmd) = ymdRange(from, to)
        return fetchPaged(
            accessToken = accessToken,
            dataType = "sleep-summary",
            endpoint = sleepEndpoint(),
            action = "getsummary",
            recordsKey = "series",
            baseParameters = listOf(
                "startdateymd" to startYmd.toString(),
                "enddateymd" to endYmd.toString(),
                "data_fields" to dataFields.joinToString(","),
            ),
        )
    }

    private fun parseTokenResponse(
        status: HttpStatusCode,
        text: String,
        now: Instant,
        existingRefreshToken: String?,
        requireUserId: Boolean,
    ): WithingsTokenSet {
        if (!status.isSuccess()) {
            throw WithingsHttpException(
                "withings_token_request_failed",
                "Withings OAuth token request failed with ${status.value}",
            )
        }

        val payload = AppJson.parseToJsonElement(text).jsonObject
        val withingsStatus = payload["status"]?.jsonPrimitive?.intOrNull
        if (withingsStatus != 0) {
            throw WithingsHttpException(
                "withings_token_request_failed",
                "Withings OAuth token request failed with status ${withingsStatus ?: "missing"}",
            )
        }

        val body = payload["body"]?.jsonObject
            ?: throw WithingsHttpException("withings_token_request_failed", "Withings OAuth token response did not include body")
        val accessToken = body.stringOrNull("access_token")
            ?: throw WithingsHttpException("withings_missing_access_token", "Withings OAuth token response did not include access_token")
        val refreshToken = body.stringOrNull("refresh_token") ?: existingRefreshToken
            ?: throw WithingsHttpException("withings_missing_refresh_token", "Withings OAuth token response did not include refresh_token")
        val providerUserId = body["userid"]?.jsonPrimitive?.contentOrNull.orEmpty()
        if (requireUserId && providerUserId.isBlank()) {
            throw WithingsHttpException("withings_missing_userid", "Withings OAuth token response did not include userid")
        }
        val tokenType = body.stringOrNull("token_type") ?: "Bearer"
        val expiresIn = body["expires_in"]?.jsonPrimitive?.longOrNull ?: 10800L
        val scope = body.stringOrNull("scope") ?: WITHINGS_SCOPES.joinToString(",")

        return WithingsTokenSet(
            providerUserId = providerUserId,
            accessToken = accessToken,
            refreshToken = refreshToken,
            tokenType = tokenType,
            expiresAt = now.plusSeconds(expiresIn),
            scope = scope,
        )
    }

    private suspend fun fetchPaged(
        accessToken: String,
        dataType: String,
        endpoint: String,
        action: String,
        recordsKey: String,
        baseParameters: List<Pair<String, String>>,
    ): WithingsFetchResult {
        val pages = mutableListOf<WithingsPage>()
        val records = mutableListOf<JsonObject>()
        val seenOffsets = mutableSetOf<String>()
        var offset: String? = null
        var pageIndex = 0

        do {
            if (pageIndex >= MAX_WITHINGS_PAGES) {
                throw WithingsHttpException(
                    "withings_page_limit_exceeded",
                    "Withings $action pagination exceeded $MAX_WITHINGS_PAGES pages",
                )
            }
            val response = httpClient.submitForm(
                url = endpoint,
                formParameters = formParameters(
                    buildList {
                        add("action" to action)
                        addAll(baseParameters)
                        offset?.let { add("offset" to it) }
                    },
                ),
            ) {
                header(HttpHeaders.Authorization, "Bearer $accessToken")
            }
            val payload = parseDataResponse(action, response.status, response.body())
            val body = payload["body"]?.jsonObject
                ?: throw WithingsHttpException("withings_malformed_response", "Withings $action response did not include body")
            pages.add(WithingsPage(endpoint, action, pageIndex, payload))
            records.addAll(body.records(recordsKey))

            val nextOffset = body["offset"]?.jsonPrimitive?.contentOrNull
                ?: body["offset"]?.jsonPrimitive?.longOrNull?.toString()
            val hasMore = body["more"]?.jsonPrimitive?.booleanOrNull
                ?: body["more"]?.jsonPrimitive?.intOrNull?.let { it == 1 }
                ?: false
            if (hasMore && nextOffset.isNullOrBlank()) {
                throw WithingsHttpException("withings_malformed_response", "Withings $action response did not include next offset")
            }
            if (hasMore && !seenOffsets.add(nextOffset!!)) {
                throw WithingsHttpException("withings_pagination_loop", "Withings $action returned a repeated offset")
            }
            offset = nextOffset.takeIf { hasMore }
            pageIndex += 1
        } while (offset != null)

        return WithingsFetchResult(dataType, pages, records)
    }

    private fun parseDataResponse(action: String, status: HttpStatusCode, text: String): JsonObject {
        if (!status.isSuccess()) {
            throw WithingsHttpException(
                "withings_data_request_failed",
                "Withings $action request failed with ${status.value}",
            )
        }
        val payload = AppJson.parseToJsonElement(text).jsonObject
        val withingsStatus = payload["status"]?.jsonPrimitive?.intOrNull
        if (withingsStatus != 0) {
            throw WithingsHttpException(
                "withings_data_request_failed",
                "Withings $action request failed with status ${withingsStatus ?: "missing"}",
            )
        }
        return payload
    }

    private fun JsonObject.records(key: String): List<JsonObject> =
        when (val element = this[key]) {
            is JsonArray -> element.mapNotNull { it as? JsonObject }
            is JsonObject -> element.entries.map { (recordKey, value) ->
                if (value is JsonObject) {
                    buildJsonObject {
                        put("timestamp", recordKey)
                        value.entries.forEach { (key, entryValue) -> put(key, entryValue) }
                    }
                } else {
                    buildJsonObject {
                        put("timestamp", recordKey)
                        put("value", value)
                    }
                }
            }
            else -> emptyList()
        }

    private fun ymdRange(from: Instant, to: Instant): Pair<LocalDate, LocalDate> =
        from.atZone(ZoneOffset.UTC).toLocalDate() to to.minusNanos(1).atZone(ZoneOffset.UTC).toLocalDate()

    private fun sleepWindows(from: Instant, to: Instant): List<Pair<Instant, Instant>> {
        val windows = mutableListOf<Pair<Instant, Instant>>()
        var windowFrom = from
        while (windowFrom.isBefore(to)) {
            val windowTo = listOf(windowFrom.plusSeconds(24 * 60 * 60), to).minOrNull()!!
            windows.add(windowFrom to windowTo)
            windowFrom = windowTo
        }
        return windows
    }

    private fun measureEndpoint(): String = "${config.apiBaseUrl.trimEnd('/')}/v2/measure"

    private fun signatureEndpoint(): String = "${config.apiBaseUrl.trimEnd('/')}/v2/signature"

    private fun sleepEndpoint(): String = "${config.apiBaseUrl.trimEnd('/')}/v2/sleep"

    private fun JsonObject.stringOrNull(key: String): String? =
        this[key]?.jsonPrimitive?.contentOrNull

    private fun sign(parameters: Map<String, String>): String {
        val payload = parameters.toSortedMap().values.joinToString(",")
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(config.clientSecret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(payload.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }
}

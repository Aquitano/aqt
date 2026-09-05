package me.aquitano.external.withings

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandler
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.HttpRequestData
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.http.content.OutgoingContent
import io.ktor.http.parseQueryString
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.runBlocking
import me.aquitano.health.infrastructure.config.WithingsConfig
import me.aquitano.health.shared.AppJson
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class WithingsOAuthClientTest {
    private val now = Instant.parse("2026-04-20T10:00:00Z")

    @Test
    fun authorizationCodeExchangeSendsRequiredFormFieldsAndParsesResponse() = runBlocking {
        var form = emptyMap<String, List<String>>()
        val client = client { request ->
            form = request.formParameters()
            respondJson(
                """
                {
                  "status": 0,
                  "body": {
                    "userid": 363,
                    "access_token": "access-from-code",
                    "refresh_token": "refresh-from-code",
                    "expires_in": 10800,
                    "scope": "user.info,user.metrics",
                    "token_type": "Bearer"
                  }
                }
                """.trimIndent()
            )
        }

        val tokens = client.exchangeCode("auth-code", now)

        assertEquals(listOf("requesttoken"), form["action"])
        assertEquals(listOf("authorization_code"), form["grant_type"])
        assertEquals(listOf("client-id"), form["client_id"])
        assertEquals(listOf("auth-code"), form["code"])
        assertEquals(listOf("http://localhost:8080/api/v2/providers/withings/oauth/callback"), form["redirect_uri"])
        assertEquals(listOf("test-nonce"), form["nonce"])
        assertTrue(!form["signature"].isNullOrEmpty())
        assertEquals("363", tokens.providerUserId)
        assertEquals("access-from-code", tokens.accessToken)
        assertEquals("refresh-from-code", tokens.refreshToken)
        assertEquals("Bearer", tokens.tokenType)
        assertEquals(now.plusSeconds(10800), tokens.expiresAt)
        assertEquals("user.info,user.metrics", tokens.scope)
    }

    @Test
    fun refreshExchangeSendsRefreshGrantAndPreservesExistingRefreshToken() = runBlocking {
        var form = emptyMap<String, List<String>>()
        val client = client { request ->
            form = request.formParameters()
            respondJson(
                """
                {
                  "status": 0,
                  "body": {
                    "access_token": "fresh-access",
                    "expires_in": 60
                  }
                }
                """.trimIndent()
            )
        }

        val tokens = client.refreshToken("existing-refresh", now)

        assertEquals(listOf("requesttoken"), form["action"])
        assertEquals(listOf("refresh_token"), form["grant_type"])
        assertEquals(listOf("client-id"), form["client_id"])
        assertEquals(listOf("existing-refresh"), form["refresh_token"])
        assertEquals(listOf("test-nonce"), form["nonce"])
        assertTrue(!form["signature"].isNullOrEmpty())
        assertEquals("fresh-access", tokens.accessToken)
        assertEquals("existing-refresh", tokens.refreshToken)
        assertEquals("", tokens.providerUserId)
        assertEquals(now.plusSeconds(60), tokens.expiresAt)
    }

    @Test
    fun nonZeroWithingsStatusMapsToTokenRequestFailure() = runBlocking {
        val client = client {
            respondJson("""{"status": 293, "body": {}}""")
        }

        val error = assertFailsWith<WithingsHttpException> {
            client.exchangeCode("auth-code", now)
        }

        assertEquals("withings_token_request_failed", error.code)
    }

    @Test
    fun missingAccessTokenMapsToExplicitError() = runBlocking {
        val client = client {
            respondJson("""{"status": 0, "body": {"userid": 363, "refresh_token": "refresh"}}""")
        }

        val error = assertFailsWith<WithingsHttpException> {
            client.exchangeCode("auth-code", now)
        }

        assertEquals("withings_missing_access_token", error.code)
    }

    @Test
    fun missingRefreshTokenOnAuthorizationCodeExchangeMapsToExplicitError() = runBlocking {
        val client = client {
            respondJson("""{"status": 0, "body": {"userid": 363, "access_token": "access"}}""")
        }

        val error = assertFailsWith<WithingsHttpException> {
            client.exchangeCode("auth-code", now)
        }

        assertEquals("withings_missing_refresh_token", error.code)
    }

    @Test
    fun missingUserIdOnAuthorizationCodeExchangeMapsToExplicitError() = runBlocking {
        val client = client {
            respondJson("""{"status": 0, "body": {"access_token": "access", "refresh_token": "refresh"}}""")
        }

        val error = assertFailsWith<WithingsHttpException> {
            client.exchangeCode("auth-code", now)
        }

        assertEquals("withings_missing_userid", error.code)
    }

    @Test
    fun httpFailureMapsToTokenRequestFailure() = runBlocking {
        val client = client {
            respond(
                content = """{"status": 0, "body": {}}""",
                status = HttpStatusCode.BadRequest,
                headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
            )
        }

        val error = assertFailsWith<WithingsHttpException> {
            client.exchangeCode("auth-code", now)
        }

        assertEquals("withings_token_request_failed", error.code)
    }

    @Test
    fun fetchMeasuresSendsBearerFormAndParsesPaginatedMeasureGroups() = runBlocking {
        val forms = mutableListOf<Map<String, List<String>>>()
        val authorizations = mutableListOf<String?>()
        val paths = mutableListOf<String>()
        val client = client { request ->
            forms.add(request.formParameters())
            authorizations.add(request.headers[HttpHeaders.Authorization])
            paths.add(request.url.encodedPath)
            if (forms.size == 1) {
                respondJson(
                    """
                    {
                      "status": 0,
                      "body": {
                        "measuregrps": [{"grpid": 1, "date": 1770000000, "measures": []}],
                        "more": 1,
                        "offset": 25
                      }
                    }
                    """.trimIndent()
                )
            } else {
                respondJson(
                    """
                    {
                      "status": 0,
                      "body": {
                        "measuregrps": [{"grpid": 2, "date": 1770000100, "measures": []}],
                        "more": 0
                      }
                    }
                    """.trimIndent()
                )
            }
        }

        val result = client.fetchMeasures(
            accessToken = "access",
            from = Instant.parse("2026-04-01T00:00:00Z"),
            to = Instant.parse("2026-04-02T00:00:00Z"),
            measureTypes = listOf(1, 6),
            category = 1,
        )

        assertEquals(listOf("/v2/measure", "/v2/measure"), paths)
        assertEquals(listOf<String?>("Bearer access", "Bearer access"), authorizations)
        assertEquals(listOf("getmeas"), forms[0]["action"])
        assertEquals(listOf("1,6"), forms[0]["meastypes"])
        assertEquals(listOf("1"), forms[0]["category"])
        assertEquals(listOf("1775001600"), forms[0]["startdate"])
        assertEquals(listOf("1775088000"), forms[0]["enddate"])
        assertEquals(listOf("25"), forms[1]["offset"])
        assertEquals(2, result.records.size)
    }

    @Test
    fun fetchActivitySendsYmdRangeAndAllDataFields() = runBlocking {
        var form = emptyMap<String, List<String>>()
        val client = client { request ->
            form = request.formParameters()
            respondJson(
                """
                {
                  "status": 0,
                  "body": {
                    "activities": [{"date": "2026-04-01", "steps": 1234}],
                    "more": false
                  }
                }
                """.trimIndent()
            )
        }

        val result = client.fetchActivity(
            accessToken = "access",
            from = Instant.parse("2026-04-01T12:00:00Z"),
            to = Instant.parse("2026-04-03T00:00:00Z"),
            dataFields = listOf("steps", "distance", "elevation"),
        )

        assertEquals(listOf("getactivity"), form["action"])
        assertEquals(listOf("2026-04-01"), form["startdateymd"])
        assertEquals(listOf("2026-04-02"), form["enddateymd"])
        assertEquals(listOf("steps,distance,elevation"), form["data_fields"])
        assertEquals(1, result.records.size)
    }

    @Test
    fun fetchSleepSplitsMoreThanTwentyFourHoursIntoWindows() = runBlocking {
        val forms = mutableListOf<Map<String, List<String>>>()
        val client = client { request ->
            forms.add(request.formParameters())
            respondJson("""{"status": 0, "body": {"model": 32, "series": {}, "more": false}}""")
        }

        client.fetchSleep(
            accessToken = "token",
            from = Instant.parse("2026-04-01T00:00:00Z"),
            to = Instant.parse("2026-04-03T00:00:00Z"),
            dataFields = listOf("state"),
        )

        assertEquals(2, forms.size)
        assertEquals(listOf("1775001600"), forms[0]["startdate"])
        assertEquals(listOf("1775088000"), forms[0]["enddate"])
        assertEquals(listOf("1775088000"), forms[1]["startdate"])
        assertEquals(listOf("1775174400"), forms[1]["enddate"])
        assertNull(forms[0]["meastypes"])
    }

    @Test
    fun nonZeroWithingsStatusMapsToDataRequestFailure() = runBlocking {
        val client = client {
            respondJson("""{"status": 293, "body": {}}""")
        }

        val error = assertFailsWith<WithingsHttpException> {
            client.fetchActivity(
                accessToken = "access",
                from = Instant.parse("2026-04-01T00:00:00Z"),
                to = Instant.parse("2026-04-02T00:00:00Z"),
                dataFields = listOf("steps"),
            )
        }

        assertEquals("withings_data_request_failed", error.code)
        assertEquals(293, error.providerStatus)
        assertEquals("getactivity", error.providerAction)
        assertEquals("https://wbsapi.withings.net/v2/measure", error.providerEndpoint)
    }

    @Test
    fun repeatedOffsetFailsPaginationLoop() = runBlocking {
        val client = client {
            respondJson(
                """
                {
                  "status": 0,
                  "body": {
                    "measuregrps": [],
                    "more": 1,
                    "offset": 25
                  }
                }
                """.trimIndent()
            )
        }

        val error = assertFailsWith<WithingsHttpException> {
            client.fetchMeasures(
                accessToken = "access",
                from = Instant.parse("2026-04-01T00:00:00Z"),
                to = Instant.parse("2026-04-02T00:00:00Z"),
                measureTypes = listOf(1),
                category = 1,
            )
        }

        assertEquals("withings_pagination_loop", error.code)
    }

    private fun client(handler: MockRequestHandler): KtorWithingsClient {
        val httpClient = HttpClient(MockEngine { request ->
            if (request.url.encodedPath == "/v2/signature") {
                respondJson("""{"status": 0, "body": {"nonce": "test-nonce"}}""")
            } else {
                handler(request)
            }
        }) {
            install(ContentNegotiation) {
                json(AppJson)
            }
        }
        return KtorWithingsClient(httpClient, config())
    }

    private fun MockRequestHandleScope.respondJson(content: String) =
        respond(
            content = content,
            status = HttpStatusCode.OK,
            headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
        )

    private fun HttpRequestData.formParameters(): Map<String, List<String>> =
        parseQueryString(bodyText()).entries()
            .associate { it.key to it.value }

    private fun HttpRequestData.bodyText(): String =
        when (val content = body) {
            is OutgoingContent.ByteArrayContent -> String(content.bytes())
            is OutgoingContent.NoContent -> ""
            else -> content.toString()
        }

    private fun config(): WithingsConfig =
        WithingsConfig(
            clientId = "client-id",
            clientSecret = "client-secret",
            redirectUri = "http://localhost:8080/api/v2/providers/withings/oauth/callback",
            tokenEncryptionKey = "test-token-encryption-key-with-32-bytes",
            apiBaseUrl = "https://wbsapi.withings.net",
            oauthTokenUrl = "https://wbsapi.withings.net/v2/oauth2",
            oauthAuthUrl = "https://account.withings.com/oauth2_user/authorize2",
        )
}

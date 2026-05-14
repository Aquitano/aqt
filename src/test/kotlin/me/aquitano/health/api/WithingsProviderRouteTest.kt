package me.aquitano.health.api

import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.config.MapApplicationConfig
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import me.aquitano.health.shared.AppJson
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class WithingsProviderRouteTest {
    @Test
    fun oauthStartRequiresBearerToken() = testApplication {
        configureTestApplication()

        val response = client.get("/api/v1/providers/withings/oauth/start")

        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    @Test
    fun oauthStartReturnsAuthorizationUrlWithDefaultScopes() = testApplication {
        configureTestApplication()

        val response = client.get("/api/v1/providers/withings/oauth/start") {
            authorized()
        }

        assertEquals(HttpStatusCode.OK, response.status)
        val body = AppJson.parseToJsonElement(response.bodyAsText()).jsonObject
        val url = body["authorizationUrl"]!!.jsonPrimitive.content
        assertTrue(url.startsWith("https://account.withings.com/oauth2_user/authorize2?"))
        assertTrue(url.contains("response_type=code"))
        assertTrue(url.contains("client_id=withings-client-id"))
        assertTrue(url.contains("scope=user.info%2Cuser.metrics%2Cuser.activity"))
    }

    @Test
    fun syncRequiresBearerToken() = testApplication {
        configureTestApplication()

        val response = client.post("/api/v1/providers/withings/sync") {
            contentType(ContentType.Application.Json)
            setBody("""{}""")
        }

        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    @Test
    fun syncReturnsNotConnectedConflict() = testApplication {
        configureTestApplication()

        val response = client.post("/api/v1/providers/withings/sync") {
            authorized()
            contentType(ContentType.Application.Json)
            setBody("""{"from":"2026-04-01T00:00:00Z","to":"2026-04-02T00:00:00Z"}""")
        }

        assertEquals(HttpStatusCode.Conflict, response.status)
        assertTrue(response.bodyAsText().contains("withings_not_connected"))
    }

    @Test
    fun oauthCallbackUsesProviderPathCodeNotAuthorizationCode() = testApplication {
        configureTestApplication()

        val response = client.get(
            "/api/v1/providers/withings/oauth/callback?code=authorization-code&state=missing-state"
        )

        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertTrue(response.bodyAsText().contains("state"))
        assertTrue(!response.bodyAsText().contains("Provider 'authorization-code' not found"))
    }

    @Test
    fun missingProviderConfigReturnsInternalServerErrorWithoutLeakingConfigFields() = testApplication {
        configureTestApplication(withClientSecret = false)

        val response = client.get("/api/v1/providers/withings/oauth/start") {
            authorized()
            header(HttpHeaders.XRequestId, "withings-config-test")
        }

        assertEquals(HttpStatusCode.InternalServerError, response.status)
        val bodyText = response.bodyAsText()
        val error = AppJson.parseToJsonElement(bodyText).jsonObject["error"]!!.jsonObject
        assertEquals("withings_not_configured", error["code"]!!.jsonPrimitive.content)
        assertEquals("Provider is not configured", error["message"]!!.jsonPrimitive.content)
        assertEquals("withings-config-test", error["requestId"]!!.jsonPrimitive.content)
        assertTrue(!bodyText.contains("withings.clientSecret"))
    }

    private fun ApplicationTestBuilder.configureTestApplication(
        withClientSecret: Boolean = true,
    ) {
        val dbPath = Files.createTempFile("aqt-health-withings-provider-route-test", ".db")
        val configValues = mutableMapOf(
            "ktor.application.modules.size" to "1",
            "ktor.application.modules.0" to "me.aquitano.health.api.ApplicationKt.module",
            "aqtHealth.database.jdbcUrl" to "jdbc:sqlite:$dbPath",
            "aqtHealth.database.driver" to "org.sqlite.JDBC",
            "aqtHealth.auth.bootstrapClientName" to "test-client",
            "aqtHealth.auth.bootstrapApiKey" to "test-key",
            "aqtHealth.withings.clientId" to "withings-client-id",
            "aqtHealth.withings.redirectUri" to "http://localhost:8080/api/v1/providers/withings/oauth/callback",
            "aqtHealth.withings.tokenEncryptionKey" to "test-token-encryption-key-with-32-bytes",
            "aqtHealth.withings.apiBaseUrl" to "https://wbsapi.withings.net",
            "aqtHealth.withings.oauthTokenUrl" to "https://wbsapi.withings.net/v2/oauth2",
            "aqtHealth.withings.oauthAuthUrl" to "https://account.withings.com/oauth2_user/authorize2",
        )
        if (withClientSecret) {
            configValues["aqtHealth.withings.clientSecret"] = "withings-client-secret"
        }
        environment {
            config = MapApplicationConfig(*configValues.map { it.key to it.value }.toTypedArray())
        }
    }

    private fun HttpRequestBuilder.authorized() {
        header(HttpHeaders.Authorization, "Bearer test-key")
    }
}

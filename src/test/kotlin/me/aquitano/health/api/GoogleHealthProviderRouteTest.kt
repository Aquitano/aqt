package me.aquitano.health.api

import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.config.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import me.aquitano.health.shared.AppJson
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class GoogleHealthProviderRouteTest {
    @Test
    fun oauthStartRequiresBearerToken() = testApplication {
        configureTestApplication()

        val response = client.get("/api/v1/providers/google-health/oauth/start")

        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    @Test
    fun oauthStartReturnsAuthorizationUrlWithReadonlyScopes() = testApplication {
        configureTestApplication()

        val response = client.get("/api/v1/providers/google-health/oauth/start") {
            authorized()
        }

        assertEquals(HttpStatusCode.OK, response.status)
        val body = AppJson.parseToJsonElement(response.bodyAsText()).jsonObject
        val url = body["authorizationUrl"]!!.jsonPrimitive.content
        assertTrue(url.contains("access_type=offline"))
        assertTrue(url.contains("prompt=consent"))
        assertTrue(url.contains("googlehealth.activity_and_fitness.readonly"))
        assertTrue(url.contains("googlehealth.health_metrics_and_measurements.readonly"))
        assertTrue(url.contains("googlehealth.sleep.readonly"))
    }

    @Test
    fun syncRequiresBearerToken() = testApplication {
        configureTestApplication()

        val response = client.post("/api/v1/providers/google-health/sync") {
            contentType(ContentType.Application.Json)
            setBody("""{"from":"2026-04-01T00:00:00Z","to":"2026-04-02T00:00:00Z"}""")
        }

        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    @Test
    fun syncRejectsInvalidDateRangeBeforeAccountLookup() = testApplication {
        configureTestApplication()

        val response = client.post("/api/v1/providers/google-health/sync") {
            authorized()
            contentType(ContentType.Application.Json)
            setBody("""{"from":"2026-04-02T00:00:00Z","to":"2026-04-01T00:00:00Z"}""")
        }

        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    private fun ApplicationTestBuilder.configureTestApplication() {
        val dbPath = Files.createTempFile("aqt-health-google-provider-route-test", ".db")
        environment {
            config = MapApplicationConfig(
                "ktor.application.modules.size" to "1",
                "ktor.application.modules.0" to "me.aquitano.health.api.ApplicationKt.module",
                "aqtHealth.database.jdbcUrl" to "jdbc:sqlite:$dbPath",
                "aqtHealth.database.driver" to "org.sqlite.JDBC",
                "aqtHealth.auth.bootstrapClientName" to "test-client",
                "aqtHealth.auth.bootstrapApiKey" to "test-key",
                "aqtHealth.googleHealth.clientId" to "client-id",
                "aqtHealth.googleHealth.clientSecret" to "client-secret",
                "aqtHealth.googleHealth.redirectUri" to "http://localhost:8080/api/v1/providers/google-health/oauth/callback",
                "aqtHealth.googleHealth.tokenEncryptionKey" to "test-token-encryption-key-with-32-bytes",
                "aqtHealth.googleHealth.apiBaseUrl" to "https://health.googleapis.com",
                "aqtHealth.googleHealth.oauthTokenUrl" to "https://oauth2.googleapis.com/token",
                "aqtHealth.googleHealth.oauthAuthUrl" to "https://accounts.google.com/o/oauth2/v2/auth",
            )
        }
    }

    private fun HttpRequestBuilder.authorized() {
        header(HttpHeaders.Authorization, "Bearer test-key")
    }
}

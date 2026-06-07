package me.aquitano.health.api

import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.config.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import me.aquitano.health.shared.AppJson
import me.aquitano.health.test.PostgresTestDatabase
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class GoogleHealthProviderRouteTest {
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
    fun syncRejectsInvalidDateRange() = testApplication {
        configureTestApplication()

        val response = client.post("/api/v1/providers/google-health/sync") {
            authorized()
            contentType(ContentType.Application.Json)
            setBody("""{"from":"2026-04-02T00:00:00Z","to":"2026-04-01T00:00:00Z"}""")
        }

        assertEquals(HttpStatusCode.BadRequest, response.status)
        val error = AppJson.parseToJsonElement(response.bodyAsText()).jsonObject["error"]!!.jsonObject
        assertEquals("validation_failed", error["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun syncLongHistoricalRangeIsNotRejectedByRangeValidation() = testApplication {
        configureTestApplication()

        val response = client.post("/api/v1/providers/google-health/sync") {
            authorized()
            contentType(ContentType.Application.Json)
            setBody("""{"from":"2020-01-01T00:00:00Z","to":"2026-01-01T00:00:00Z","dataTypes":["steps"]}""")
        }

        assertEquals(HttpStatusCode.Conflict, response.status)
        assertTrue(response.bodyAsText().contains("google_health_not_connected"))
    }

    @Test
    fun syncRejectsInvalidPageSize() = testApplication {
        configureTestApplication()

        val response = client.post("/api/v1/providers/google-health/sync") {
            authorized()
            contentType(ContentType.Application.Json)
            setBody("""{"from":"2026-04-01T00:00:00Z","to":"2026-04-02T00:00:00Z","pageSize":0}""")
        }

        assertEquals(HttpStatusCode.BadRequest, response.status)
        val error = AppJson.parseToJsonElement(response.bodyAsText()).jsonObject["error"]!!.jsonObject
        assertEquals("validation_failed", error["code"]!!.jsonPrimitive.content)
    }

    @Test
    fun missingProviderConfigReturnsInternalServerErrorWithoutLeakingConfigFields() = testApplication {
        configureTestApplication(withClientSecret = false)

        val response = client.get("/api/v1/providers/google-health/oauth/start") {
            authorized()
            header(HttpHeaders.XRequestId, "google-config-test")
        }

        assertEquals(HttpStatusCode.InternalServerError, response.status)
        val bodyText = response.bodyAsText()
        val error = AppJson.parseToJsonElement(bodyText).jsonObject["error"]!!.jsonObject
        assertEquals("google_health_not_configured", error["code"]!!.jsonPrimitive.content)
        assertEquals("Provider is not configured", error["message"]!!.jsonPrimitive.content)
        assertEquals("google-config-test", error["requestId"]!!.jsonPrimitive.content)
        assertTrue(!bodyText.contains("googleHealth.clientSecret"))
    }

    private fun ApplicationTestBuilder.configureTestApplication(
        withClientSecret: Boolean = true,
    ) {
        val dbConfig = PostgresTestDatabase.config()
        val configValues = mutableMapOf(
            "ktor.application.modules.size" to "1",
            "ktor.application.modules.0" to "me.aquitano.health.api.ApplicationKt.module",
            "aqtHealth.auth.bootstrapClientName" to "test-client",
            "aqtHealth.auth.bootstrapApiKey" to "test-key",
            "aqtHealth.googleHealth.clientId" to "client-id",
            "aqtHealth.googleHealth.redirectUri" to "http://localhost:8080/api/v1/providers/google-health/oauth/callback",
            "aqtHealth.googleHealth.tokenEncryptionKey" to "test-token-encryption-key-with-32-bytes",
            "aqtHealth.googleHealth.apiBaseUrl" to "https://health.googleapis.com",
            "aqtHealth.googleHealth.oauthTokenUrl" to "https://oauth2.googleapis.com/token",
            "aqtHealth.googleHealth.oauthAuthUrl" to "https://accounts.google.com/o/oauth2/v2/auth",
        )
        configValues.putAll(PostgresTestDatabase.ktorConfigEntries(dbConfig).toMap())
        if (withClientSecret) {
            configValues["aqtHealth.googleHealth.clientSecret"] = "client-secret"
        }
        environment {
            config = MapApplicationConfig(*configValues.map { it.key to it.value }.toTypedArray())
        }
    }

    private fun HttpRequestBuilder.authorized() {
        header(HttpHeaders.Authorization, "Bearer test-key")
    }
}

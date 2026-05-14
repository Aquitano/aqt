package me.aquitano.health.api

import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.config.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import me.aquitano.health.shared.AppJson
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class ApplicationTest {
    @Test
    fun healthEndpointResponds() = testApplication {
        configureTestApplication()
        val response = client.get("/api/v1/admin/health")

        assertEquals(HttpStatusCode.OK, response.status)
        val body = AppJson.parseToJsonElement(response.bodyAsText()).jsonObject
        assertEquals("ok", body["status"]!!.jsonPrimitive.content)
    }

    @Test
    fun requestIdIsEchoedFromHeaderOrGeneratedWhenAbsent() = testApplication {
        configureTestApplication()

        val withId = client.get("/api/v1/admin/health") {
            header(HttpHeaders.XRequestId, "test-request-123")
        }
        assertEquals("test-request-123", withId.headers[HttpHeaders.XRequestId])

        val withoutId = client.get("/api/v1/admin/health")
        val generated = withoutId.headers[HttpHeaders.XRequestId]
        assertNotNull(generated)
        assertTrue(generated.isNotBlank())
    }

    @Test
    fun unauthorizedResponseIncludesErrorCodeAndRequestId() = testApplication {
        configureTestApplication()

        val response = client.get("/api/v1/admin/ingestion/batches") {
            header(HttpHeaders.XRequestId, "test-request-123")
        }

        assertEquals(HttpStatusCode.Unauthorized, response.status)
        assertEquals("test-request-123", response.headers[HttpHeaders.XRequestId])
        val error = response.jsonBody()["error"]!!.jsonObject
        assertEquals("unauthorized", error["code"]!!.jsonPrimitive.content)
        assertEquals("Missing or invalid API key", error["message"]!!.jsonPrimitive.content)
        assertEquals("test-request-123", error["requestId"]!!.jsonPrimitive.content)
    }

    @Test
    fun validationErrorDetailsIncludeMachineReadableCodes() = testApplication {
        configureTestApplication()

        val response = client.get("/api/v1/dashboard/summary?fromDate=not-a-date&toDate=2026-04-02") {
            header(HttpHeaders.Authorization, "Bearer test-key")
        }

        assertEquals(HttpStatusCode.BadRequest, response.status)
        val error = response.jsonBody()["error"]!!.jsonObject
        val detail = error["details"]!!.jsonArray.first().jsonObject
        assertEquals("validation_failed", error["code"]!!.jsonPrimitive.content)
        assertEquals("invalid_format", detail["code"]!!.jsonPrimitive.content)
        assertEquals("fromDate", detail["field"]!!.jsonPrimitive.content)
        assertNotNull(error["requestId"]!!.jsonPrimitive.content)
    }

    @Test
    fun openApiDocumentIsGenerated() = testApplication {
        configureTestApplication()

        val response = client.get("/openapi")

        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(ContentType.Application.Json, response.contentType())
        val body = AppJson.parseToJsonElement(response.bodyAsText()).jsonObject
        assertNotNull(body["openapi"])
        assertNotNull(body["paths"])
        // The /openapi route itself must not appear in the spec
        assertFalse(response.bodyAsText().contains("\"/openapi\""))
    }

    private fun ApplicationTestBuilder.configureTestApplication() {
        val dbPath = Files.createTempFile("aqt-health-app-test", ".db")
        environment {
            config = MapApplicationConfig(
                "ktor.application.modules.size" to "1",
                "ktor.application.modules.0" to "me.aquitano.health.api.ApplicationKt.module",
                "aqtHealth.database.jdbcUrl" to "jdbc:sqlite:$dbPath",
                "aqtHealth.database.driver" to "org.sqlite.JDBC",
                "aqtHealth.auth.bootstrapClientName" to "test-client",
                "aqtHealth.auth.bootstrapApiKey" to "test-key",
            )
        }
    }

    private suspend fun HttpResponse.jsonBody() =
        AppJson.parseToJsonElement(bodyAsText()).jsonObject
}

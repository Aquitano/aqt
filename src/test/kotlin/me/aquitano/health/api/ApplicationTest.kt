package me.aquitano.health.api

import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.config.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import me.aquitano.health.test.PostgresTestDatabase
import me.aquitano.health.shared.AppJson
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
        assertNotNull(body["components"]!!.jsonObject["securitySchemes"]!!.jsonObject["bearerApiKey"])
        assertEquals(
            "bearerApiKey",
            body["security"]!!.jsonArray.first().jsonObject.keys.first()
        )
        // The /openapi route itself must not appear in the spec
        assertFalse(response.bodyAsText().contains("\"/openapi\""))
    }

    @Test
    fun openApiDocumentContainsContractMetadata() = testApplication {
        configureTestApplication()

        val body = client.get("/openapi").jsonBody()
        val paths = body["paths"]!!.jsonObject

        listOf(
            "/api/v1/admin/health",
            "/api/v1/ingestion/batches",
            "/api/v1/providers",
            "/api/v1/providers/status",
            "/api/v1/providers/{providerCode}",
            "/api/v1/providers/{providerCode}/status",
            "/api/v1/providers/{providerCode}/oauth/start",
            "/api/v1/providers/{providerCode}/oauth/callback",
            "/api/v1/providers/{providerCode}/sync",
            "/api/v1/metrics/catalog",
            "/api/v1/health/day",
            "/api/v1/metrics/steps",
            "/api/v1/metrics/steps/daily",
            "/api/v1/sleep/sessions",
            "/api/v1/sleep/nights",
            "/api/v1/body/measurements",
            "/api/v1/metrics/heart-rate",
            "/api/v1/dashboard/summary",
            "/api/v1/admin/ingestion/batches",
            "/api/v1/admin/ingestion/batches/{id}",
            "/api/v1/admin/ingestion/failures",
        ).forEach { path ->
            assertNotNull(paths[path], "Missing OpenAPI path $path")
        }

        assertTrue(body["servers"]!!.jsonArray.isNotEmpty())
        assertEquals(
            setOf("Admin", "Ingestion", "Providers", "Read"),
            body["tags"]!!.jsonArray.map { it.jsonObject["name"]!!.jsonPrimitive.content }.toSet(),
        )
    }

    @Test
    fun openApiUsesSecuritySchemeInsteadOfAuthorizationParameter() = testApplication {
        configureTestApplication()

        val body = client.get("/openapi").jsonBody()
        val paths = body["paths"]!!.jsonObject
        val protectedOperation = paths["/api/v1/providers"]!!.jsonObject["get"]!!.jsonObject
        val publicHealthOperation = paths["/api/v1/admin/health"]!!.jsonObject["get"]!!.jsonObject
        val publicCallbackOperation =
            paths["/api/v1/providers/{providerCode}/oauth/callback"]!!.jsonObject["get"]!!.jsonObject

        assertNotNull(body["components"]!!.jsonObject["securitySchemes"]!!.jsonObject["bearerApiKey"])
        assertEquals("bearerApiKey", protectedOperation["security"]!!.jsonArray.first().jsonObject.keys.first())
        assertTrue(publicHealthOperation["security"]!!.jsonArray.first().jsonObject.isEmpty())
        assertTrue(publicCallbackOperation["security"]!!.jsonArray.first().jsonObject.isEmpty())

        val specText = client.get("/openapi").bodyAsText()
        assertFalse(specText.contains("\"name\":\"Authorization\""))
        assertFalse(specText.contains("\"name\": \"Authorization\""))
    }

    @Test
    fun openApiDocumentsQueryConstraintsAndPolymorphicIngestion() = testApplication {
        configureTestApplication()

        val body = client.get("/openapi").jsonBody()
        val paths = body["paths"]!!.jsonObject
        val stepParams = paths["/api/v1/metrics/steps"]!!.jsonObject["get"]!!.jsonObject["parameters"]!!.jsonArray
        val limit = stepParams.first { it.jsonObject["name"]!!.jsonPrimitive.content == "limit" }
            .jsonObject["schema"]!!.jsonObject
        assertEquals(500, limit["default"]!!.jsonPrimitive.int)
        assertEquals(5000.0, limit["maximum"]!!.jsonPrimitive.double)

        val from = stepParams.first { it.jsonObject["name"]!!.jsonPrimitive.content == "from" }
            .jsonObject["schema"]!!.jsonObject
        assertEquals("date-time", from["format"]!!.jsonPrimitive.content)

        val dailyStepParamNames = paths["/api/v1/metrics/steps/daily"]!!.jsonObject["get"]!!.jsonObject["parameters"]!!
            .jsonArray.map { it.jsonObject["name"]!!.jsonPrimitive.content }.toSet()
        assertTrue("date" in dailyStepParamNames)
        assertTrue("fromDate" in dailyStepParamNames)
        assertTrue("toDate" in dailyStepParamNames)

        val bodyMetricParamNames = paths["/api/v1/body/measurements"]!!.jsonObject["get"]!!.jsonObject["parameters"]!!
            .jsonArray.map { it.jsonObject["name"]!!.jsonPrimitive.content }.toSet()
        assertTrue("metricType" in bodyMetricParamNames)
        assertTrue("latest" in bodyMetricParamNames)

        val schemas = body["components"]!!.jsonObject["schemas"]!!.jsonObject
        val providerStatus = schemas["ProviderStatusResponseDto"]!!.jsonObject
        assertEquals(
            setOf("configure", "connect", "reconnect", "sync"),
            providerStatus["properties"]!!.jsonObject["nextAction"]!!.jsonObject["enum"]!!
                .jsonArray.map { it.jsonPrimitive.content }.toSet(),
        )
        val providerAccountStatus = schemas["ProviderAccountStatusResponseDto"]!!.jsonObject
        assertEquals(
            setOf("valid", "expired", "missing", "unknown"),
            providerAccountStatus["properties"]!!.jsonObject["tokenStatus"]!!.jsonObject["enum"]!!
                .jsonArray.map { it.jsonPrimitive.content }.toSet(),
        )
        val healthDay = schemas["HealthDayResponse"]!!.jsonObject
        assertEquals(
            setOf("steps", "heartRate", "weight", "sleep"),
            healthDay["properties"]!!.jsonObject["modules"]!!.jsonObject["items"]!!.jsonObject["enum"]!!
                .jsonArray.map { it.jsonPrimitive.content }.toSet(),
        )

        listOf(
            "StepIntervalDto",
            "SleepSessionDto",
            "BodyMeasurementDto",
            "HeartRateDto",
        ).forEach { schemaName ->
            assertNotNull(schemas[schemaName], "Missing OpenAPI component schema $schemaName")
        }

        val requestSchema = paths["/api/v1/ingestion/batches"]!!.jsonObject["post"]!!.jsonObject["requestBody"]!!
            .jsonObject["content"]!!.jsonObject["application/json"]!!.jsonObject["schema"]!!.jsonObject
        val recordRefs = requestSchema["properties"]!!.jsonObject["records"]!!.jsonObject["items"]!!.jsonObject["oneOf"]!!
            .jsonArray.map { it.jsonObject["\$ref"]!!.jsonPrimitive.content }
            .toSet()
        assertEquals(
            setOf(
                "#/components/schemas/StepIntervalDto",
                "#/components/schemas/SleepSessionDto",
                "#/components/schemas/BodyMeasurementDto",
                "#/components/schemas/HeartRateDto",
            ),
            recordRefs,
        )
        assertTrue(
            requestSchema.toString().contains("oneOf") || requestSchema.toString().contains("IngestionRecordDto"),
            "Ingestion request schema should expose polymorphic records",
        )
    }

    private fun ApplicationTestBuilder.configureTestApplication() {
        val dbConfig = PostgresTestDatabase.config()
        environment {
            config = MapApplicationConfig(
                "ktor.application.modules.size" to "1",
                "ktor.application.modules.0" to "me.aquitano.health.api.ApplicationKt.module",
                *PostgresTestDatabase.ktorConfigEntries(dbConfig),
                "aqtHealth.auth.bootstrapClientName" to "test-client",
                "aqtHealth.auth.bootstrapApiKey" to "test-key",
            )
        }
    }

    private suspend fun HttpResponse.jsonBody() =
        AppJson.parseToJsonElement(bodyAsText()).jsonObject
}

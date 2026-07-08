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
        val response = client.get("/api/v2/admin/health")

        assertEquals(HttpStatusCode.OK, response.status)
        val body = AppJson.parseToJsonElement(response.bodyAsText()).jsonObject
        assertEquals("ok", body["status"]!!.jsonPrimitive.content)
    }

    @Test
    fun metricsEndpointReturnsRegistryScrape() = testApplication {
        configureTestApplication()
        val response = client.get("/metrics")

        assertEquals(HttpStatusCode.OK, response.status)
        val bodyText = response.bodyAsText()
        assertTrue(bodyText.isNotBlank())
    }

    @Test
    fun requestIdIsEchoedFromHeaderOrGeneratedWhenAbsent() = testApplication {
        configureTestApplication()

        val withId = client.get("/api/v2/admin/health") {
            header(HttpHeaders.XRequestId, "test-request-123")
        }
        assertEquals("test-request-123", withId.headers[HttpHeaders.XRequestId])

        val withoutId = client.get("/api/v2/admin/health")
        val generated = withoutId.headers[HttpHeaders.XRequestId]
        assertNotNull(generated)
        assertTrue(generated.isNotBlank())
    }

    @Test
    fun unauthorizedResponseIncludesErrorCodeAndRequestId() = testApplication {
        configureTestApplication()

        val response = client.get("/api/v2/admin/ingestion/batches") {
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

        val response = client.get("/api/v2/dashboard/summary?fromDate=not-a-date&toDate=2026-04-02") {
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
    fun openApiDocumentContainsContractMetadata() = testApplication {
        configureTestApplication()

        val body = client.get("/openapi").jsonBody()
        val paths = body["paths"]!!.jsonObject

        listOf(
            "/api/v2/admin/health",
            "/api/v2/ingestion/batches",
            "/api/v2/providers",
            "/api/v2/providers/status",
            "/api/v2/providers/{providerCode}",
            "/api/v2/providers/{providerCode}/status",
            "/api/v2/providers/{providerCode}/accounts",
            "/api/v2/providers/{providerCode}/accounts/{providerInstanceId}",
            "/api/v2/providers/{providerCode}/accounts/{providerInstanceId}/disconnect",
            "/api/v2/providers/{providerCode}/accounts/{providerInstanceId}/reconnect",
            "/api/v2/providers/{providerCode}/oauth/start",
            "/api/v2/providers/{providerCode}/oauth/callback",
            "/api/v2/providers/{providerCode}/sync",
            "/api/v2/metrics",
            "/api/v2/health/day",
            "/api/v2/steps",
            "/api/v2/steps/daily",
            "/api/v2/activity/summaries",
            "/api/v2/sleep/sessions",
            "/api/v2/sleep/nights",
            "/api/v2/sleep/summaries",
            "/api/v2/metrics/{metricType}",
            "/api/v2/metrics/{metricType}/summary",
            "/api/v2/metrics/{metricType}/daily",
            "/api/v2/blood-pressure",
            "/api/v2/dashboard/summary",
            "/api/v2/admin/ingestion/batches",
            "/api/v2/admin/ingestion/batches/{id}",
            "/api/v2/admin/ingestion/failures",
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
        val protectedOperation = paths["/api/v2/providers"]!!.jsonObject["get"]!!.jsonObject
        val publicHealthOperation = paths["/api/v2/admin/health"]!!.jsonObject["get"]!!.jsonObject
        val publicCallbackOperation =
            paths["/api/v2/providers/{providerCode}/oauth/callback"]!!.jsonObject["get"]!!.jsonObject

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
        val stepParams = paths["/api/v2/steps"]!!.jsonObject["get"]!!.jsonObject["parameters"]!!.jsonArray
        val limit = stepParams.first { it.jsonObject["name"]!!.jsonPrimitive.content == "limit" }
            .jsonObject["schema"]!!.jsonObject
        assertEquals(500, limit["default"]!!.jsonPrimitive.int)
        assertEquals(5000.0, limit["maximum"]!!.jsonPrimitive.double)

        val from = stepParams.first { it.jsonObject["name"]!!.jsonPrimitive.content == "from" }
            .jsonObject["schema"]!!.jsonObject
        assertEquals("date-time", from["format"]!!.jsonPrimitive.content)

        val dailyStepParamNames = paths["/api/v2/steps/daily"]!!.jsonObject["get"]!!.jsonObject["parameters"]!!
            .jsonArray.map { it.jsonObject["name"]!!.jsonPrimitive.content }.toSet()
        assertTrue("date" in dailyStepParamNames)
        assertTrue("fromDate" in dailyStepParamNames)
        assertTrue("toDate" in dailyStepParamNames)
        assertTrue("latest" in dailyStepParamNames)
        assertTrue("cursor" in dailyStepParamNames)
        assertFalse("canonical" in dailyStepParamNames)
        assertFalse("from" in dailyStepParamNames)
        assertFalse("to" in dailyStepParamNames)

        val activityParamNames = paths["/api/v2/activity/summaries"]!!.jsonObject["get"]!!.jsonObject["parameters"]!!
            .jsonArray.map { it.jsonObject["name"]!!.jsonPrimitive.content }.toSet()
        assertTrue("date" in activityParamNames)
        assertTrue("fromDate" in activityParamNames)
        assertTrue("toDate" in activityParamNames)
        assertTrue("latest" in activityParamNames)
        assertTrue("cursor" in activityParamNames)
        assertFalse("from" in activityParamNames)
        assertFalse("to" in activityParamNames)

        val scalarMetricParamNames = paths["/api/v2/metrics/{metricType}"]!!.jsonObject["get"]!!.jsonObject["parameters"]!!
            .jsonArray.map { it.jsonObject["name"]!!.jsonPrimitive.content }.toSet()
        assertTrue("metricType" in scalarMetricParamNames)
        assertTrue("latest" in scalarMetricParamNames)
        assertTrue("raw" in scalarMetricParamNames)
        assertTrue("cursor" in scalarMetricParamNames)
        assertFalse("canonical" in scalarMetricParamNames)

        val dashboardParamNames = paths["/api/v2/dashboard/summary"]!!.jsonObject["get"]!!.jsonObject["parameters"]!!
            .jsonArray.map { it.jsonObject["name"]!!.jsonPrimitive.content }.toSet()
        assertFalse("canonical" in dashboardParamNames)

        val healthDayParamNames = paths["/api/v2/health/day"]!!.jsonObject["get"]!!.jsonObject["parameters"]!!
            .jsonArray.map { it.jsonObject["name"]!!.jsonPrimitive.content }.toSet()
        assertFalse("canonical" in healthDayParamNames)

        val schemas = body["components"]!!.jsonObject["schemas"]!!.jsonObject
        val providerStatus = schemas["ProviderStatusResponseDto"]!!.jsonObject
        assertEquals(
            setOf("configure", "connect", "reconnect", "sync"),
            providerStatus["properties"]!!.jsonObject["nextAction"]!!.jsonObject["enum"]!!
                .jsonArray.map { it.jsonPrimitive.content }.toSet(),
        )
        val providerAccountStatus = schemas["ProviderAccountStatusResponseDto"]!!.jsonObject
        assertEquals(
            setOf("not_connected", "connected", "needs_reauth", "disconnected", "configuration_error"),
            providerAccountStatus["properties"]!!.jsonObject["status"]!!.jsonObject["enum"]!!
                .jsonArray.map { it.jsonPrimitive.content }.toSet(),
        )
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
            "ActivitySummaryDto",
            "SleepSummaryDto",
            "RespiratoryRateDto",
            "HrvDto",
            "BloodPressureDto",
            "CardiovascularDto",
            "ExtendedBodyMeasurementDto",
            "ScalarSampleDto",
        ).forEach { schemaName ->
            assertNotNull(schemas[schemaName], "Missing OpenAPI component schema $schemaName")
        }

        val requestSchema = paths["/api/v2/ingestion/batches"]!!.jsonObject["post"]!!.jsonObject["requestBody"]!!
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
                "#/components/schemas/ActivitySummaryDto",
                "#/components/schemas/SleepSummaryDto",
                "#/components/schemas/RespiratoryRateDto",
                "#/components/schemas/HrvDto",
                "#/components/schemas/BloodPressureDto",
                "#/components/schemas/CardiovascularDto",
                "#/components/schemas/ExtendedBodyMeasurementDto",
                "#/components/schemas/ScalarSampleDto",
            ),
            recordRefs,
        )
        assertTrue(
            requestSchema.toString().contains("oneOf") || requestSchema.toString().contains("IngestionRecordDto"),
            "Ingestion request schema should expose polymorphic records",
        )
    }

    @Test
    fun openApiDocumentsEndpointSpecificReadSortEnums() = testApplication {
        configureTestApplication()

        val paths = client.get("/openapi").jsonBody()["paths"]!!.jsonObject

        assertEquals(listOf("endAt"), paths.sortEnum("/api/v2/sleep/summaries"))
        assertEquals(listOf("startAt"), paths.sortEnum("/api/v2/sleep/sessions"))
        assertEquals(listOf("measuredAt"), paths.sortEnum("/api/v2/metrics/{metricType}"))
        assertEquals(listOf("date"), paths.sortEnum("/api/v2/steps/daily"))
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

    private fun JsonObject.sortEnum(path: String): List<String> =
        this[path]!!.jsonObject["get"]!!.jsonObject["parameters"]!!.jsonArray
            .first { it.jsonObject["name"]!!.jsonPrimitive.content == "sort" }
            .jsonObject["schema"]!!.jsonObject["enum"]!!.jsonArray
            .map { it.jsonPrimitive.content }
}

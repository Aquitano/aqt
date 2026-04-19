package me.aquitano.health.api

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
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import me.aquitano.health.shared.AppJson
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals

class ReadApiRouteTest {
    @Test
    fun readEndpointsReturnPersistedMetrics() = testApplication {
        configureTestApplication()
        ingestMixedBatch()

        val steps = authorizedGet("/api/v1/metrics/steps?from=2026-04-19T00:00:00Z&to=2026-04-20T00:00:00Z&includeSource=true")
        assertEquals(HttpStatusCode.OK, steps.status)
        assertEquals(1, steps.items().size)
        assertEquals(1200, steps.items()[0].jsonObject["steps"]!!.jsonPrimitive.int)
        assertEquals("health_connect", steps.items()[0].jsonObject["source"]!!.jsonObject["provider"]!!.jsonPrimitive.content)

        val daily = authorizedGet("/api/v1/metrics/steps/daily?fromDate=2026-04-19&toDate=2026-04-19")
        assertEquals(1200, daily.items()[0].jsonObject["steps"]!!.jsonPrimitive.int)

        val sleep = authorizedGet("/api/v1/sleep/sessions")
        assertEquals(1, sleep.items().size)
        assertEquals(2, sleep.items()[0].jsonObject["stages"]!!.jsonArray.size)

        val body = authorizedGet("/api/v1/body/measurements?metricType=weight")
        assertEquals(1, body.items().size)
        assertEquals("weight", body.items()[0].jsonObject["metricType"]!!.jsonPrimitive.content)

        val heartRate = authorizedGet("/api/v1/metrics/heart-rate")
        assertEquals(1, heartRate.items().size)
        assertEquals("unknown", heartRate.items()[0].jsonObject["context"]!!.jsonPrimitive.content)

        val batches = authorizedGet("/api/v1/admin/ingestion/batches")
        assertEquals(1, batches.items().size)
        assertEquals(4, batches.items()[0].jsonObject["recordCount"]!!.jsonPrimitive.int)

        val failures = authorizedGet("/api/v1/admin/ingestion/failures")
        assertEquals(0, failures.items().size)
    }

    @Test
    fun readEndpointsValidateRangesAndRequireAuth() = testApplication {
        configureTestApplication()

        val unauthorized = client.get("/api/v1/metrics/steps")
        assertEquals(HttpStatusCode.Unauthorized, unauthorized.status)

        val invalidRange = authorizedGet("/api/v1/metrics/steps?from=2026-04-20T00:00:00Z&to=2026-04-19T00:00:00Z")
        assertEquals(HttpStatusCode.BadRequest, invalidRange.status)
        assertEquals("validation_failed", invalidRange.jsonBody()["error"]!!.jsonObject["code"]!!.jsonPrimitive.content)
    }

    private fun ApplicationTestBuilder.configureTestApplication() {
        val dbPath = Files.createTempFile("aqt-health-read-test", ".db")
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

    private suspend fun ApplicationTestBuilder.ingestMixedBatch() {
        val response = client.post("/api/v1/ingestion/batches") {
            authorized()
            contentType(ContentType.Application.Json)
            setBody(mixedPayload())
        }
        assertEquals(HttpStatusCode.Created, response.status)
    }

    private suspend fun ApplicationTestBuilder.authorizedGet(path: String) =
        client.get(path) {
            authorized()
        }

    private fun io.ktor.client.request.HttpRequestBuilder.authorized() {
        header(HttpHeaders.Authorization, "Bearer test-key")
    }

    private suspend fun io.ktor.client.statement.HttpResponse.jsonBody(): JsonObject =
        AppJson.parseToJsonElement(bodyAsText()).jsonObject

    private suspend fun io.ktor.client.statement.HttpResponse.items(): JsonArray =
        jsonBody()["items"]!!.jsonArray

    private fun mixedPayload(): String =
        """
        {
          "provider": "health-connect",
          "providerInstanceId": "pixel-8-health-connect",
          "batchExternalId": "read-batch-1",
          "ingestedAt": "2026-04-19T10:00:00Z",
          "rawPayload": {
            "exportId": "read-batch-1"
          },
          "records": [
            {
              "type": "step_interval",
              "providerRecordId": "steps-read-1",
              "startAt": "2026-04-19T08:00:00Z",
              "endAt": "2026-04-19T09:00:00Z",
              "steps": 1200
            },
            {
              "type": "sleep_session",
              "providerRecordId": "sleep-read-1",
              "startAt": "2026-04-18T22:30:00Z",
              "endAt": "2026-04-19T06:45:00Z",
              "stages": [
                {
                  "stage": "light",
                  "startAt": "2026-04-18T22:30:00Z",
                  "endAt": "2026-04-19T00:15:00Z"
                },
                {
                  "stage": "deep",
                  "startAt": "2026-04-19T00:15:00Z",
                  "endAt": "2026-04-19T02:00:00Z"
                }
              ]
            },
            {
              "type": "body_measurement",
              "providerRecordId": "body-read-1",
              "measuredAt": "2026-04-19T07:00:00Z",
              "weightKg": 82.4,
              "bodyFatPercent": 18.2,
              "muscleKg": 34.7,
              "waterPercent": 55.1,
              "visceralFatRating": 8.0
            },
            {
              "type": "heart_rate",
              "providerRecordId": "hr-read-1",
              "measuredAt": "2026-04-19T08:30:00Z",
              "bpm": 62
            }
          ]
        }
        """.trimIndent()
}

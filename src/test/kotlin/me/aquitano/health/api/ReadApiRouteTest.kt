package me.aquitano.health.api

import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.config.*
import io.ktor.server.testing.*
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.*
import me.aquitano.health.shared.AppJson
import java.sql.DriverManager
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull

class ReadApiRouteTest {
    @Test
    fun readEndpointsReturnPersistedMetrics() = testApplication {
        configureTestApplication()
        ingestMixedBatch()

        val steps =
            authorizedGet("/api/v1/metrics/steps?from=2026-04-19T00:00:00Z&to=2026-04-20T00:00:00Z&includeSource=true")
        assertEquals(HttpStatusCode.OK, steps.status)
        assertEquals(1, steps.items().size)
        assertEquals(
            1200,
            steps.items()[0].jsonObject["steps"]!!.jsonPrimitive.int
        )
        assertEquals(
            "health_connect",
            steps.items()[0].jsonObject["source"]!!.jsonObject["provider"]!!.jsonPrimitive.content
        )

        val daily =
            authorizedGet("/api/v1/metrics/steps/daily?fromDate=2026-04-19&toDate=2026-04-19")
        assertEquals(
            1200,
            daily.items()[0].jsonObject["steps"]!!.jsonPrimitive.int
        )

        val sleep = authorizedGet("/api/v1/sleep/sessions")
        assertEquals(1, sleep.items().size)
        assertEquals(2, sleep.items()[0].jsonObject["stages"]!!.jsonArray.size)

        val body = authorizedGet("/api/v1/body/measurements?metricType=weight")
        assertEquals(1, body.items().size)
        assertEquals(
            "weight",
            body.items()[0].jsonObject["metricType"]!!.jsonPrimitive.content
        )

        val heartRate = authorizedGet("/api/v1/metrics/heart-rate")
        assertEquals(1, heartRate.items().size)
        assertEquals(
            "unknown",
            heartRate.items()[0].jsonObject["context"]!!.jsonPrimitive.content
        )

        val batches = authorizedGet("/api/v1/admin/ingestion/batches")
        assertEquals(1, batches.items().size)
        assertEquals(
            4,
            batches.items()[0].jsonObject["recordCount"]!!.jsonPrimitive.int
        )

        val failures = authorizedGet("/api/v1/admin/ingestion/failures")
        assertEquals(0, failures.items().size)
    }

    @Test
    fun readEndpointsValidateRangesAndRequireAuth() = testApplication {
        configureTestApplication()

        val unauthorized = client.get("/api/v1/metrics/steps")
        assertEquals(HttpStatusCode.Unauthorized, unauthorized.status)

        val invalidRange =
            authorizedGet("/api/v1/metrics/steps?from=2026-04-20T00:00:00Z&to=2026-04-19T00:00:00Z")
        assertEquals(HttpStatusCode.BadRequest, invalidRange.status)
        assertEquals(
            "validation_failed",
            invalidRange.jsonBody()["error"]!!.jsonObject["code"]!!.jsonPrimitive.content
        )
    }

    @Test
    fun queryModeEndpointsReturnLatestAndDateSpecificData() = testApplication {
        configureTestApplication()
        ingestMixedBatch()
        ingestLaterBatch()

        val latestWeight =
            authorizedGet("/api/v1/body/measurements?metricType=weight&latest=true")
        assertEquals(HttpStatusCode.OK, latestWeight.status)
        assertEquals(1, latestWeight.items().size)
        assertEquals(
            "weight",
            latestWeight.items()[0].jsonObject["metricType"]!!.jsonPrimitive.content
        )
        assertEquals(
            83.1,
            latestWeight.items()[0].jsonObject["value"]!!.jsonPrimitive.double
        )

        val latestHeartRate =
            authorizedGet("/api/v1/metrics/heart-rate?latest=true")
        assertEquals(1, latestHeartRate.items().size)
        assertEquals(
            67,
            latestHeartRate.items()[0].jsonObject["bpm"]!!.jsonPrimitive.int
        )

        val datedSteps =
            authorizedGet("/api/v1/metrics/steps/daily?date=2026-04-19")
        assertEquals(1, datedSteps.items().size)
        assertEquals(
            "2026-04-19",
            datedSteps.items()[0].jsonObject["date"]!!.jsonPrimitive.content
        )
        assertEquals(
            1600,
            datedSteps.items()[0].jsonObject["steps"]!!.jsonPrimitive.int
        )

        val invalidDateCombination =
            authorizedGet("/api/v1/metrics/steps/daily?date=2026-04-19&fromDate=2026-04-19")
        assertEquals(HttpStatusCode.BadRequest, invalidDateCombination.status)
        assertEquals(
            "validation_failed",
            invalidDateCombination.jsonBody()["error"]!!.jsonObject["code"]!!.jsonPrimitive.content
        )

        val latestSleep = authorizedGet("/api/v1/sleep/sessions?latest=true")
        assertEquals(1, latestSleep.items().size)
        assertEquals(
            "2026-04-19T22:00:00Z",
            latestSleep.items()[0].jsonObject["startAt"]!!.jsonPrimitive.content
        )
        assertEquals(1, latestSleep.items()[0].jsonObject["stages"]!!.jsonArray.size)
    }

    @Test
    fun dashboardSummaryReturnsCompactRangeData() = testApplication {
        configureTestApplication()
        ingestMixedBatch()
        ingestLaterBatch()

        val response =
            authorizedGet("/api/v1/dashboard/summary?fromDate=2026-04-19&toDate=2026-04-19")
        assertEquals(HttpStatusCode.OK, response.status)
        val body = response.jsonBody()
        assertEquals(
            1600,
            body["steps"]!!.jsonObject["steps"]!!.jsonPrimitive.int
        )
        assertEquals(
            2,
            body["steps"]!!.jsonObject["sampleCount"]!!.jsonPrimitive.int
        )
        assertEquals(
            83.1,
            body["latestWeight"]!!.jsonObject["value"]!!.jsonPrimitive.double
        )
        assertEquals(
            67,
            body["latestHeartRate"]!!.jsonObject["bpm"]!!.jsonPrimitive.int
        )
        assertEquals(
            "2026-04-19T22:00:00Z",
            body["lastSleepSession"]!!.jsonObject["startAt"]!!.jsonPrimitive.content
        )

        val unauthorized = client.get("/api/v1/dashboard/summary?fromDate=2026-04-19&toDate=2026-04-19")
        assertEquals(HttpStatusCode.Unauthorized, unauthorized.status)
    }

    @Test
    fun dashboardRelatedProtectedReadsCanRunConcurrently() = testApplication {
        val dbPath = configureTestApplication()
        ingestMixedBatch()
        ingestLaterBatch()

        val paths = listOf(
            "/api/v1/dashboard/summary?fromDate=2026-04-19&toDate=2026-04-19",
            "/api/v1/metrics/steps/daily?fromDate=2026-04-19&toDate=2026-04-19&includeSource=true",
            "/api/v1/body/measurements?metricType=weight&latest=true&includeSource=true",
            "/api/v1/metrics/heart-rate?latest=true&includeSource=true",
            "/api/v1/sleep/sessions?latest=true&includeSource=true",
            "/api/v1/admin/ingestion/batches?limit=10",
            "/api/v1/admin/ingestion/failures?limit=10",
        )

        val responses = coroutineScope {
            paths.map { path ->
                async { authorizedGet(path) }
            }.awaitAll()
        }

        responses.forEach { response ->
            assertEquals(HttpStatusCode.OK, response.status)
        }
        assertNotNull(lastUsedAt(dbPath))
    }

    @Test
    fun adminBatchDetailReturnsRecordsAndOptionalPayloads() = testApplication {
        configureTestApplication()
        val batchId = ingestMixedBatch()

        val detail =
            authorizedGet("/api/v1/admin/ingestion/batches/$batchId")
        assertEquals(HttpStatusCode.OK, detail.status)
        val body = detail.jsonBody()
        assertEquals(batchId, body["id"]!!.jsonPrimitive.int)
        assertEquals(4, body["recordCount"]!!.jsonPrimitive.int)
        assertEquals(4, body["records"]!!.jsonArray.size)
        assertFalse(body.containsKey("sourcePayload"))
        assertFalse(body.containsKey("normalizedPayload"))
        assertFalse(
            body["records"]!!.jsonArray[0].jsonObject.containsKey("normalizedRecord")
        )

        val withSource =
            authorizedGet("/api/v1/admin/ingestion/batches/$batchId?includeSourcePayload=true")
        assertEquals(
            "read-batch-1",
            withSource.jsonBody()["sourcePayload"]!!.jsonObject["exportId"]!!.jsonPrimitive.content
        )

        val withNormalized =
            authorizedGet("/api/v1/admin/ingestion/batches/$batchId?includeNormalizedPayload=true")
        assertEquals(
            "health_connect",
            withNormalized.jsonBody()["normalizedPayload"]!!.jsonObject["provider"]!!.jsonPrimitive.content
        )
        assertEquals(
            "step_interval",
            withNormalized.jsonBody()["records"]!!.jsonArray[0].jsonObject["normalizedRecord"]!!.jsonObject["type"]!!.jsonPrimitive.content
        )

        val missing = authorizedGet("/api/v1/admin/ingestion/batches/999999")
        assertEquals(HttpStatusCode.NotFound, missing.status)
        assertEquals(
            "not_found",
            missing.jsonBody()["error"]!!.jsonObject["code"]!!.jsonPrimitive.content
        )

        val invalid = authorizedGet("/api/v1/admin/ingestion/batches/not-an-int")
        assertEquals(HttpStatusCode.BadRequest, invalid.status)
        assertEquals(
            "validation_failed",
            invalid.jsonBody()["error"]!!.jsonObject["code"]!!.jsonPrimitive.content
        )
    }

    private fun ApplicationTestBuilder.configureTestApplication(): Path {
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
        return dbPath
    }

    private suspend fun ApplicationTestBuilder.ingestMixedBatch(): Int {
        val response = client.post("/api/v1/ingestion/batches") {
            authorized()
            contentType(ContentType.Application.Json)
            setBody(mixedPayload())
        }
        assertEquals(HttpStatusCode.Created, response.status)
        return response.jsonBody()["batchId"]!!.jsonPrimitive.int
    }

    private suspend fun ApplicationTestBuilder.ingestLaterBatch(): Int {
        val response = client.post("/api/v1/ingestion/batches") {
            authorized()
            contentType(ContentType.Application.Json)
            setBody(laterPayload())
        }
        assertEquals(HttpStatusCode.Created, response.status)
        return response.jsonBody()["batchId"]!!.jsonPrimitive.int
    }

    private suspend fun ApplicationTestBuilder.authorizedGet(path: String) =
        client.get(path) {
            authorized()
        }

    private fun HttpRequestBuilder.authorized() {
        header(HttpHeaders.Authorization, "Bearer test-key")
    }

    private fun lastUsedAt(dbPath: Path): String? =
        DriverManager.getConnection("jdbc:sqlite:$dbPath").use { connection ->
            connection.createStatement().use { statement ->
                statement.executeQuery("SELECT last_used_at FROM api_clients WHERE name = 'test-client'").use { resultSet ->
                    if (resultSet.next()) resultSet.getString("last_used_at") else null
                }
            }
        }

    private suspend fun HttpResponse.jsonBody(): JsonObject =
        AppJson.parseToJsonElement(bodyAsText()).jsonObject

    private suspend fun HttpResponse.items(): JsonArray =
        jsonBody()["items"]!!.jsonArray

    private fun mixedPayload(): String =
        """
        {
          "provider": "health-connect",
          "providerInstanceId": "pixel-8-health-connect",
          "batchExternalId": "read-batch-1",
          "ingestedAt": "2026-04-19T10:00:00Z",
          "sourcePayload": {
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

    private fun laterPayload(): String =
        """
        {
          "provider": "health-connect",
          "providerInstanceId": "pixel-8-health-connect",
          "batchExternalId": "read-batch-2",
          "ingestedAt": "2026-04-19T23:00:00Z",
          "sourcePayload": {
            "exportId": "read-batch-2"
          },
          "records": [
            {
              "type": "step_interval",
              "providerRecordId": "steps-read-2",
              "startAt": "2026-04-19T20:00:00Z",
              "endAt": "2026-04-19T21:00:00Z",
              "steps": 400
            },
            {
              "type": "sleep_session",
              "providerRecordId": "sleep-read-2",
              "startAt": "2026-04-19T22:00:00Z",
              "endAt": "2026-04-20T06:00:00Z",
              "stages": [
                {
                  "stage": "light",
                  "startAt": "2026-04-19T22:00:00Z",
                  "endAt": "2026-04-20T06:00:00Z"
                }
              ]
            },
            {
              "type": "body_measurement",
              "providerRecordId": "body-read-2",
              "measuredAt": "2026-04-19T21:30:00Z",
              "weightKg": 83.1
            },
            {
              "type": "heart_rate",
              "providerRecordId": "hr-read-2",
              "measuredAt": "2026-04-19T21:45:00Z",
              "bpm": 67,
              "context": "resting"
            }
          ]
        }
        """.trimIndent()
}

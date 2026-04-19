package me.aquitano.health.api

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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import me.aquitano.health.shared.AppJson
import java.nio.file.Files
import java.nio.file.Path
import java.sql.DriverManager
import kotlin.test.Test
import kotlin.test.assertEquals

class IngestionRouteTest {
    @Test
    fun ingestionRequiresBearerToken() = testApplication {
        val dbPath = configureTestApplication()

        val response = client.post("/api/v1/ingestion/batches") {
            contentType(ContentType.Application.Json)
            setBody(minimalStepPayload())
        }

        assertEquals(HttpStatusCode.Unauthorized, response.status)
        assertEquals(0, countRows(dbPath, "raw_ingestion_batches"))
    }

    @Test
    fun ingestionRejectsInvalidRequest() = testApplication {
        configureTestApplication()

        val response = client.post("/api/v1/ingestion/batches") {
            authorized()
            contentType(ContentType.Application.Json)
            setBody(
                """
                {
                  "provider": "",
                  "providerInstanceId": "pixel",
                  "ingestedAt": "2026-04-19T10:00:00Z",
                  "rawPayload": {},
                  "records": []
                }
                """.trimIndent(),
            )
        }

        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("validation_failed", response.errorCode())
    }

    @Test
    fun mixedBatchPersistsRawAndCanonicalRecords() = testApplication {
        val dbPath = configureTestApplication()

        val response = client.post("/api/v1/ingestion/batches") {
            authorized()
            contentType(ContentType.Application.Json)
            setBody(mixedPayload(batchExternalId = "mixed-1"))
        }

        assertEquals(HttpStatusCode.Created, response.status)
        val body = response.jsonBody()
        assertEquals(4, body["recordsReceived"]!!.jsonPrimitive.int)
        assertEquals(4, body["rawRecordsStored"]!!.jsonPrimitive.int)
        assertEquals(1, body["canonicalRecordsCreated"]!!.jsonObject["stepSamples"]!!.jsonPrimitive.int)
        assertEquals(1, body["canonicalRecordsCreated"]!!.jsonObject["sleepSessions"]!!.jsonPrimitive.int)
        assertEquals(2, body["canonicalRecordsCreated"]!!.jsonObject["sleepStages"]!!.jsonPrimitive.int)
        assertEquals(5, body["canonicalRecordsCreated"]!!.jsonObject["bodyMeasurements"]!!.jsonPrimitive.int)
        assertEquals(1, body["canonicalRecordsCreated"]!!.jsonObject["heartRateSamples"]!!.jsonPrimitive.int)

        assertEquals(1, countRows(dbPath, "raw_ingestion_batches"))
        assertEquals(4, countRows(dbPath, "raw_ingestion_records"))
        assertEquals(1, countRows(dbPath, "step_samples"))
        assertEquals(1, countRows(dbPath, "step_daily_summaries"))
        assertEquals(1200, singleInt(dbPath, "SELECT steps FROM step_daily_summaries"))
        assertEquals(1, countRows(dbPath, "sleep_sessions"))
        assertEquals(2, countRows(dbPath, "sleep_stages"))
        assertEquals(5, countRows(dbPath, "body_measurements"))
        assertEquals(1, countRows(dbPath, "heart_rate_samples"))
        assertEquals("processed", singleString(dbPath, "SELECT status FROM raw_ingestion_batches"))
        assertEquals("unknown", singleString(dbPath, "SELECT context FROM heart_rate_samples"))
    }

    @Test
    fun batchExternalIdIsIdempotentPerSourceInstance() = testApplication {
        val dbPath = configureTestApplication()

        val first = client.post("/api/v1/ingestion/batches") {
            authorized()
            contentType(ContentType.Application.Json)
            setBody(minimalStepPayload(batchExternalId = "dupe-batch"))
        }
        val second = client.post("/api/v1/ingestion/batches") {
            authorized()
            contentType(ContentType.Application.Json)
            setBody(minimalStepPayload(batchExternalId = "dupe-batch"))
        }

        assertEquals(HttpStatusCode.Created, first.status)
        assertEquals(HttpStatusCode.OK, second.status)
        assertEquals(true, second.jsonBody()["duplicateBatch"]!!.jsonPrimitive.content == "true")
        assertEquals(1, countRows(dbPath, "raw_ingestion_batches"))
        assertEquals(1, countRows(dbPath, "raw_ingestion_records"))
        assertEquals(1, countRows(dbPath, "step_samples"))
        assertEquals(1200, singleInt(dbPath, "SELECT steps FROM step_daily_summaries"))
    }

    @Test
    fun providerRecordDuplicatesDoNotInflateCanonicalTables() = testApplication {
        val dbPath = configureTestApplication()

        repeat(2) {
            val response = client.post("/api/v1/ingestion/batches") {
                authorized()
                contentType(ContentType.Application.Json)
                setBody(minimalStepPayload(batchExternalId = null))
            }
            assertEquals(HttpStatusCode.Created, response.status)
        }

        assertEquals(2, countRows(dbPath, "raw_ingestion_batches"))
        assertEquals(2, countRows(dbPath, "raw_ingestion_records"))
        assertEquals(1, countRows(dbPath, "step_samples"))
        assertEquals(1200, singleInt(dbPath, "SELECT steps FROM step_daily_summaries"))
    }

    private fun ApplicationTestBuilder.configureTestApplication(): Path {
        val dbPath = Files.createTempFile("aqt-health-ingestion-test", ".db")
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

    private fun io.ktor.client.request.HttpRequestBuilder.authorized() {
        header(HttpHeaders.Authorization, "Bearer test-key")
    }

    private suspend fun io.ktor.client.statement.HttpResponse.jsonBody(): JsonObject =
        AppJson.parseToJsonElement(bodyAsText()).jsonObject

    private suspend fun io.ktor.client.statement.HttpResponse.errorCode(): String =
        jsonBody()["error"]!!.jsonObject["code"]!!.jsonPrimitive.content

    private fun countRows(dbPath: Path, tableName: String): Int =
        singleInt(dbPath, "SELECT COUNT(*) FROM $tableName")

    private fun singleInt(dbPath: Path, sql: String): Int =
        DriverManager.getConnection("jdbc:sqlite:$dbPath").use { connection ->
            connection.createStatement().use { statement ->
                statement.executeQuery(sql).use { resultSet ->
                    resultSet.next()
                    resultSet.getInt(1)
                }
            }
        }

    private fun singleString(dbPath: Path, sql: String): String =
        DriverManager.getConnection("jdbc:sqlite:$dbPath").use { connection ->
            connection.createStatement().use { statement ->
                statement.executeQuery(sql).use { resultSet ->
                    resultSet.next()
                    resultSet.getString(1)
                }
            }
        }

    private fun minimalStepPayload(batchExternalId: String? = "steps-1-batch"): String {
        val batch = batchExternalId?.let { """"batchExternalId": "$it",""" } ?: ""
        return """
            {
              "provider": "health_connect",
              "providerInstanceId": "pixel-8-health-connect",
              $batch
              "ingestedAt": "2026-04-19T10:00:00Z",
              "rawPayload": {
                "exportId": "steps"
              },
              "records": [
                {
                  "type": "step_interval",
                  "providerRecordId": "steps-1",
                  "startAt": "2026-04-19T08:00:00Z",
                  "endAt": "2026-04-19T09:00:00Z",
                  "steps": 1200
                }
              ]
            }
        """.trimIndent()
    }

    private fun mixedPayload(batchExternalId: String): String =
        """
        {
          "provider": "health-connect",
          "providerInstanceId": "pixel-8-health-connect",
          "batchExternalId": "$batchExternalId",
          "ingestedAt": "2026-04-19T10:00:00Z",
          "rawPayload": {
            "exportId": "$batchExternalId"
          },
          "records": [
            {
              "type": "step_interval",
              "providerRecordId": "steps-1",
              "startAt": "2026-04-19T08:00:00Z",
              "endAt": "2026-04-19T09:00:00Z",
              "steps": 1200
            },
            {
              "type": "sleep_session",
              "providerRecordId": "sleep-1",
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
              "providerRecordId": "body-1",
              "measuredAt": "2026-04-19T07:00:00Z",
              "weightKg": 82.4,
              "bodyFatPercent": 18.2,
              "muscleKg": 34.7,
              "waterPercent": 55.1,
              "visceralFatRating": 8.0
            },
            {
              "type": "heart_rate",
              "providerRecordId": "hr-1",
              "measuredAt": "2026-04-19T08:30:00Z",
              "bpm": 62
            }
          ]
        }
        """.trimIndent()
}

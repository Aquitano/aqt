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
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import me.aquitano.health.domain.BodyMetricTypes

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
    fun metricCatalogDescribesCurrentReadSurfaces() = testApplication {
        configureTestApplication()

        val unauthorized = client.get("/api/v1/metrics/catalog")
        assertEquals(HttpStatusCode.Unauthorized, unauthorized.status)

        val response = authorizedGet("/api/v1/metrics/catalog")
        assertEquals(HttpStatusCode.OK, response.status)
        val families = response.jsonBody()["families"]!!.jsonArray
        assertEquals(
            setOf("steps", "sleep", "body_measurements", "heart_rate"),
            families.map { it.jsonObject["name"]!!.jsonPrimitive.content }.toSet(),
        )

        val steps = families.family("steps")
        assertContains(steps.endpointPaths(), "/api/v1/metrics/steps")
        assertContains(steps.endpointPaths(), "/api/v1/metrics/steps/daily")
        assertContains(steps.queryParameterNames(), "from")
        assertContains(steps.queryParameterNames(), "to")
        assertContains(steps.queryParameterNames(), "includeSource")
        assertContains(steps.queryParameterNames(), "sort")
        assertContains(steps.queryParameterNames(), "order")
        assertContains(steps.modeNames(), "raw")
        assertContains(steps.modeNames(), "daily")
        assertContains(steps.modeNames(), "summary")
        assertContains(steps.modeNames(), "day")
        assertContains(steps.endpointPaths(), "/api/v1/health/day")

        val body = families.family("body_measurements")
        assertEquals(
            BodyMetricTypes.supported.sorted(),
            body["metricTypes"]!!.jsonArray.map { it.jsonPrimitive.content },
        )
        assertEquals(
            BodyMetricTypes.supported.sorted(),
            body.queryParameterValues("metricType"),
        )
        assertContains(body.endpointPaths(), "/api/v1/body/measurements")
        assertContains(body.endpointPaths(), "/api/v1/body/measurements/latest")

        val sleep = families.family("sleep")
        val nightMode = sleep["aggregationModes"]!!.jsonArray
            .map { it.jsonObject }
            .single { it["name"]!!.jsonPrimitive.content == "night" }
        assertEquals(true, nightMode["available"]!!.jsonPrimitive.boolean)
        assertContains(sleep.endpointPaths(), "/api/v1/sleep/nights")
        assertContains(sleep.queryParameterNames(), "date")
        assertContains(sleep.queryParameterNames(), "fromDate")
        assertContains(sleep.queryParameterNames(), "toDate")
        assertContains(sleep.queryParameterNames(), "timezone")

        val heartRate = families.family("heart_rate")
        assertContains(heartRate.endpointPaths(), "/api/v1/metrics/heart-rate")
        assertContains(heartRate.endpointPaths(), "/api/v1/metrics/heart-rate/summary")
        assertContains(heartRate.modeNames(), "latest")
        assertContains(heartRate.modeNames(), "day")
    }

    @Test
    fun healthDayReturnsRequestedMergedModulesWithBucketsAndClippedSleep() = testApplication {
        configureTestApplication()
        ingestMixedBatch()
        ingestLaterBatch()

        val unauthorized =
            client.get("/api/v1/health/day?date=2026-04-19&modules=steps")
        assertEquals(HttpStatusCode.Unauthorized, unauthorized.status)

        val invalid =
            authorizedGet("/api/v1/health/day?date=bad&timezone=Not/AZone&modules=steps,nope")
        assertEquals(HttpStatusCode.BadRequest, invalid.status)
        assertEquals(
            "validation_failed",
            invalid.jsonBody()["error"]!!.jsonObject["code"]!!.jsonPrimitive.content
        )

        val stepsOnly =
            authorizedGet("/api/v1/health/day?date=2026-04-19&timezone=UTC&modules=steps")
        assertEquals(HttpStatusCode.OK, stepsOnly.status)
        assertNotNull(stepsOnly.jsonBody()["steps"])
        assertFalse(stepsOnly.jsonBody().containsKey("heartRate"))
        assertFalse(stepsOnly.jsonBody().containsKey("weight"))
        assertFalse(stepsOnly.jsonBody().containsKey("sleep"))

        val response =
            authorizedGet("/api/v1/health/day?date=2026-04-19&timezone=UTC&modules=steps,heartRate,weight,sleep&includeSource=true")
        assertEquals(HttpStatusCode.OK, response.status)
        val body = response.jsonBody()
        assertEquals("2026-04-19", body["date"]!!.jsonPrimitive.content)
        assertEquals("2026-04-19T00:00:00Z", body["from"]!!.jsonPrimitive.content)
        assertEquals("2026-04-20T00:00:00Z", body["to"]!!.jsonPrimitive.content)
        assertEquals(1600, body["steps"]!!.jsonObject["total"]!!.jsonPrimitive.int)
        assertEquals(96, body["steps"]!!.jsonObject["buckets"]!!.jsonArray.size)
        assertEquals(2, body["heartRate"]!!.jsonObject["count"]!!.jsonPrimitive.int)
        assertEquals(62, body["heartRate"]!!.jsonObject["minBpm"]!!.jsonPrimitive.int)
        assertEquals(67, body["heartRate"]!!.jsonObject["latest"]!!.jsonObject["bpm"]!!.jsonPrimitive.int)
        assertEquals(
            "health_connect",
            body["heartRate"]!!.jsonObject["latest"]!!.jsonObject["source"]!!.jsonObject["provider"]!!.jsonPrimitive.content
        )
        assertEquals(83.1, body["weight"]!!.jsonObject["latest"]!!.jsonObject["value"]!!.jsonPrimitive.double)
        assertFalse(body["weight"]!!.jsonObject.containsKey("previous"))
        assertEquals(2, body["weight"]!!.jsonObject["points"]!!.jsonArray.size)
        assertEquals(14400, body["sleep"]!!.jsonObject["totalDurationSeconds"]!!.jsonPrimitive.long)
        assertEquals(
            "2026-04-19T00:00:00Z",
            body["sleep"]!!.jsonObject["timeline"]!!.jsonArray.first().jsonObject["startAt"]!!.jsonPrimitive.content
        )

        val berlin =
            authorizedGet("/api/v1/health/day?date=2026-04-20&timezone=Europe/Berlin&modules=sleep")
        assertEquals("2026-04-19T22:00:00Z", berlin.jsonBody()["from"]!!.jsonPrimitive.content)
        assertEquals("2026-04-20T22:00:00Z", berlin.jsonBody()["to"]!!.jsonPrimitive.content)
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
    fun metricListReadsReturnMetadataAndHonorSortOrderLimitAndLatestValidation() = testApplication {
        configureTestApplication()
        ingestMixedBatch()
        ingestLaterBatch()

        val descendingHeartRate =
            authorizedGet("/api/v1/metrics/heart-rate?order=desc&limit=1")
        assertEquals(HttpStatusCode.OK, descendingHeartRate.status)
        assertEquals(1, descendingHeartRate.items().size)
        assertEquals(
            67,
            descendingHeartRate.items()[0].jsonObject["bpm"]!!.jsonPrimitive.int
        )
        val meta = descendingHeartRate.meta()
        assertEquals(1, meta["count"]!!.jsonPrimitive.int)
        assertEquals(1, meta["limit"]!!.jsonPrimitive.int)
        assertEquals("measuredAt", meta["sort"]!!.jsonPrimitive.content)
        assertEquals("desc", meta["order"]!!.jsonPrimitive.content)
        assertFalse(meta.containsKey("nextCursor"))

        val ascendingHeartRate =
            authorizedGet("/api/v1/metrics/heart-rate?order=asc&limit=1")
        assertEquals(62, ascendingHeartRate.items()[0].jsonObject["bpm"]!!.jsonPrimitive.int)

        val latestSteps = authorizedGet("/api/v1/metrics/steps?latest=true")
        assertEquals(HttpStatusCode.OK, latestSteps.status)
        assertEquals(1, latestSteps.items().size)
        assertEquals(
            400,
            latestSteps.items()[0].jsonObject["steps"]!!.jsonPrimitive.int
        )
        assertEquals("desc", latestSteps.meta()["order"]!!.jsonPrimitive.content)
        assertEquals(1, latestSteps.meta()["limit"]!!.jsonPrimitive.int)

        val invalidLimit = authorizedGet("/api/v1/metrics/heart-rate?limit=0")
        assertEquals(HttpStatusCode.BadRequest, invalidLimit.status)

        val invalidOrder = authorizedGet("/api/v1/metrics/heart-rate?order=newest")
        assertEquals(HttpStatusCode.BadRequest, invalidOrder.status)
        assertEquals(
            "order",
            invalidOrder.errorDetails()[0].jsonObject["field"]!!.jsonPrimitive.content
        )

        val invalidSort = authorizedGet("/api/v1/metrics/heart-rate?sort=startAt")
        assertEquals(HttpStatusCode.BadRequest, invalidSort.status)
        assertEquals(
            "sort",
            invalidSort.errorDetails()[0].jsonObject["field"]!!.jsonPrimitive.content
        )

        val unsupportedLatest =
            authorizedGet("/api/v1/metrics/steps/daily?latest=true")
        assertEquals(HttpStatusCode.BadRequest, unsupportedLatest.status)
        assertEquals(
            "latest",
            unsupportedLatest.errorDetails()[0].jsonObject["field"]!!.jsonPrimitive.content
        )

        val latestWithLimit =
            authorizedGet("/api/v1/metrics/heart-rate?latest=true&limit=1")
        assertEquals(HttpStatusCode.BadRequest, latestWithLimit.status)
        assertEquals(
            "limit",
            latestWithLimit.errorDetails()[0].jsonObject["field"]!!.jsonPrimitive.content
        )
    }

    @Test
    fun heartRateSummaryAndBodyLatestAliasReturnFocusedMetricViews() = testApplication {
        configureTestApplication()
        ingestMixedBatch()
        ingestLaterBatch()

        val summary =
            authorizedGet("/api/v1/metrics/heart-rate/summary?from=2026-04-19T00:00:00Z&to=2026-04-20T00:00:00Z")
        assertEquals(HttpStatusCode.OK, summary.status)
        val summaryBody = summary.jsonBody()
        assertEquals(2, summaryBody["count"]!!.jsonPrimitive.int)
        assertEquals(62, summaryBody["minBpm"]!!.jsonPrimitive.int)
        assertEquals(67, summaryBody["maxBpm"]!!.jsonPrimitive.int)
        assertEquals(64.5, summaryBody["avgBpm"]!!.jsonPrimitive.double)
        assertEquals(
            67,
            summaryBody["latest"]!!.jsonObject["bpm"]!!.jsonPrimitive.int
        )

        val emptySummary =
            authorizedGet("/api/v1/metrics/heart-rate/summary?from=2026-04-18T00:00:00Z&to=2026-04-18T01:00:00Z")
        val emptyBody = emptySummary.jsonBody()
        assertEquals(0, emptyBody["count"]!!.jsonPrimitive.int)
        assertFalse(emptyBody.containsKey("minBpm"))
        assertFalse(emptyBody.containsKey("maxBpm"))
        assertFalse(emptyBody.containsKey("avgBpm"))
        assertFalse(emptyBody.containsKey("latest"))

        val latestWeight =
            authorizedGet("/api/v1/body/measurements/latest?metricType=weight")
        assertEquals(HttpStatusCode.OK, latestWeight.status)
        assertEquals(
            83.1,
            latestWeight.jsonBody()["item"]!!.jsonObject["value"]!!.jsonPrimitive.double
        )

        val missingMetricType = authorizedGet("/api/v1/body/measurements/latest")
        assertEquals(HttpStatusCode.BadRequest, missingMetricType.status)
        assertEquals(
            "metricType",
            missingMetricType.errorDetails()[0].jsonObject["field"]!!.jsonPrimitive.content
        )
    }

    @Test
    fun sleepNightsReturnCompleteSessionsByLocalizedEndDate() = testApplication {
        configureTestApplication()
        ingestSleepNightBatch()

        val april20 =
            authorizedGet("/api/v1/sleep/nights?date=2026-04-20&timezone=Europe/Berlin")
        assertEquals(HttpStatusCode.OK, april20.status)
        assertEquals(1, april20.items().size)
        val april20Night = april20.items()[0].jsonObject
        assertEquals("2026-04-20", april20Night["date"]!!.jsonPrimitive.content)
        assertEquals("Europe/Berlin", april20Night["timezone"]!!.jsonPrimitive.content)
        val april20Session = april20Night["session"]!!.jsonObject
        assertEquals(
            "2026-04-19T22:00:00Z",
            april20Session["startAt"]!!.jsonPrimitive.content
        )
        assertEquals(
            "2026-04-20T06:00:00Z",
            april20Session["endAt"]!!.jsonPrimitive.content
        )
        assertEquals(1, april20Session["stages"]!!.jsonArray.size)

        val april21 =
            authorizedGet("/api/v1/sleep/nights?date=2026-04-21&timezone=Europe/Berlin")
        assertEquals(HttpStatusCode.OK, april21.status)
        assertEquals(1, april21.items().size)
        val april21Session = april21.items()[0].jsonObject["session"]!!.jsonObject
        assertEquals(
            "2026-04-20T22:00:00Z",
            april21Session["startAt"]!!.jsonPrimitive.content
        )
        assertEquals(
            "2026-04-21T06:00:00Z",
            april21Session["endAt"]!!.jsonPrimitive.content
        )

        val rawApril20 =
            authorizedGet("/api/v1/sleep/sessions?from=2026-04-20T00:00:00Z&to=2026-04-21T00:00:00Z")
        assertEquals(HttpStatusCode.OK, rawApril20.status)
        assertEquals(1, rawApril20.items().size)
        assertEquals(
            "2026-04-20T22:00:00Z",
            rawApril20.items()[0].jsonObject["startAt"]!!.jsonPrimitive.content
        )
    }

    @Test
    fun sleepNightReadsValidateDateAndTimezoneParameters() = testApplication {
        configureTestApplication()

        val invalidTimezone = authorizedGet("/api/v1/sleep/nights?date=2026-04-20&timezone=Not/AZone")
        assertEquals(HttpStatusCode.BadRequest, invalidTimezone.status)
        assertEquals(
            "validation_failed",
            invalidTimezone.jsonBody()["error"]!!.jsonObject["code"]!!.jsonPrimitive.content
        )

        val invalidCombination =
            authorizedGet("/api/v1/sleep/nights?date=2026-04-20&fromDate=2026-04-20")
        assertEquals(HttpStatusCode.BadRequest, invalidCombination.status)
        assertEquals(
            "validation_failed",
            invalidCombination.jsonBody()["error"]!!.jsonObject["code"]!!.jsonPrimitive.content
        )

        val invalidRange =
            authorizedGet("/api/v1/sleep/nights?fromDate=2026-04-21&toDate=2026-04-20")
        assertEquals(HttpStatusCode.BadRequest, invalidRange.status)
        assertEquals(
            "validation_failed",
            invalidRange.jsonBody()["error"]!!.jsonObject["code"]!!.jsonPrimitive.content
        )
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
            "2026-04-18T22:30:00Z",
            body["lastSleepSession"]!!.jsonObject["startAt"]!!.jsonPrimitive.content
        )

        val unauthorized = client.get("/api/v1/dashboard/summary?fromDate=2026-04-19&toDate=2026-04-19")
        assertEquals(HttpStatusCode.Unauthorized, unauthorized.status)
    }

    @Test
    fun dashboardSummaryUsesSelectedSleepNight() = testApplication {
        configureTestApplication()
        ingestSleepNightBatch()

        val april20 =
            authorizedGet("/api/v1/dashboard/summary?fromDate=2026-04-20&toDate=2026-04-20&timezone=Europe/Berlin")
        assertEquals(HttpStatusCode.OK, april20.status)
        assertEquals(
            "2026-04-19T22:00:00Z",
            april20.jsonBody()["lastSleepSession"]!!.jsonObject["startAt"]!!.jsonPrimitive.content
        )

        val april19 =
            authorizedGet("/api/v1/dashboard/summary?fromDate=2026-04-19&toDate=2026-04-19&timezone=Europe/Berlin")
        assertEquals(HttpStatusCode.OK, april19.status)
        assertFalse(april19.jsonBody().containsKey("lastSleepSession"))
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

    private suspend fun ApplicationTestBuilder.ingestSleepNightBatch(): Int {
        val response = client.post("/api/v1/ingestion/batches") {
            authorized()
            contentType(ContentType.Application.Json)
            setBody(sleepNightPayload())
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

    private suspend fun HttpResponse.meta(): JsonObject =
        jsonBody()["meta"]!!.jsonObject

    private suspend fun HttpResponse.errorDetails(): JsonArray =
        jsonBody()["error"]!!.jsonObject["details"]!!.jsonArray

    private fun JsonArray.family(name: String): JsonObject =
        map { it.jsonObject }
            .single { it["name"]!!.jsonPrimitive.content == name }

    private fun JsonObject.endpointPaths(): List<String> =
        this["readEndpoints"]!!.jsonArray
            .mapNotNull { it.jsonObject["path"]?.jsonPrimitive?.content }

    private fun JsonObject.queryParameterNames(): List<String> =
        this["queryParameters"]!!.jsonArray
            .map { it.jsonObject["name"]!!.jsonPrimitive.content }

    private fun JsonObject.queryParameterValues(name: String): List<String> =
        this["queryParameters"]!!.jsonArray
            .map { it.jsonObject }
            .single { it["name"]!!.jsonPrimitive.content == name }
            .getValue("values")
            .jsonArray
            .map { it.jsonPrimitive.content }

    private fun JsonObject.modeNames(): List<String> =
        this["aggregationModes"]!!.jsonArray
            .map { it.jsonObject["name"]!!.jsonPrimitive.content }

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

    private fun sleepNightPayload(): String =
        """
        {
          "provider": "health-connect",
          "providerInstanceId": "pixel-8-health-connect",
          "batchExternalId": "sleep-night-read-batch",
          "ingestedAt": "2026-04-21T08:00:00Z",
          "sourcePayload": {
            "exportId": "sleep-night-read-batch"
          },
          "records": [
            {
              "type": "sleep_session",
              "providerRecordId": "sleep-night-2026-04-20",
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
              "type": "sleep_session",
              "providerRecordId": "sleep-night-2026-04-21",
              "startAt": "2026-04-20T22:00:00Z",
              "endAt": "2026-04-21T06:00:00Z",
              "stages": [
                {
                  "stage": "deep",
                  "startAt": "2026-04-20T22:00:00Z",
                  "endAt": "2026-04-21T06:00:00Z"
                }
              ]
            }
          ]
        }
        """.trimIndent()
}

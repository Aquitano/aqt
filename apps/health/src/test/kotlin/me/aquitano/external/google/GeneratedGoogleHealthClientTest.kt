package me.aquitano.external.google

import com.google.api.gax.rpc.ApiException
import com.google.api.gax.rpc.StatusCode
import com.google.devicesandservices.health.v4.DataPoint
import com.google.devicesandservices.health.v4.ListDataPointsRequest
import com.google.devicesandservices.health.v4.ListDataPointsResponse
import com.google.protobuf.util.JsonFormat
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonPrimitive
import java.net.URI
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class GeneratedGoogleHealthClientTest {
    @Test
    fun dataPointsServiceSettingsUseProvidedOAuthAccessToken() {
        val settings = dataPointsServiceSettings("oauth-access-token")
        val metadata = settings.credentialsProvider
            .credentials
            .getRequestMetadata(URI("https://health.googleapis.com"))

        assertEquals(listOf("Bearer oauth-access-token"), metadata["Authorization"])
    }

    @Test
    fun fetchDataPointsConvertsSupportedDataTypesToNormalizerShape() = runBlocking {
        val fixture = Fixture()
        val pointsByDataType = mapOf(
            "steps" to stepsPoint(),
            "sleep" to sleepPoint(),
            "heart-rate" to heartRatePoint(),
            "weight" to weightPoint(),
            "body-fat" to bodyFatPoint(),
        )

        pointsByDataType.forEach { (dataType, point) ->
            fixture.service.responses += ListDataPointsResponse.newBuilder()
                .addDataPoints(point)
                .build()

            val result = fixture.client.fetchDataPoints(
                accessToken = "access-token",
                dataType = dataType,
                from = fixture.from,
                to = fixture.to,
                pageSize = 1000,
            )

            val normalized = GoogleHealthNormalizer().normalize(result)
            assertEquals(1, normalized.records.size, dataType)
            assertEquals(point.name, result.dataPoints.single()["name"]?.jsonPrimitive?.content, dataType)
        }
    }

    @Test
    fun fetchDataPointsCollectsPaginatedResponsesAndRecordsPageIndexes() = runBlocking {
        val fixture = Fixture()
        fixture.service.responses += ListDataPointsResponse.newBuilder()
            .addDataPoints(stepsPoint("steps-1"))
            .setNextPageToken("next-page")
            .build()
        fixture.service.responses += ListDataPointsResponse.newBuilder()
            .addDataPoints(stepsPoint("steps-2"))
            .build()

        val result = fixture.client.fetchDataPoints("access-token", "steps", fixture.from, fixture.to, 1000)

        assertEquals(listOf(0, 1), result.pages.map { it.pageIndex })
        assertEquals(listOf("steps-1", "steps-2"), result.dataPoints.map { it["name"]?.jsonPrimitive?.content })
        assertEquals("next-page", fixture.service.requests[1].pageToken)
    }

    @Test
    fun fetchDataPointsRejectsRepeatedPageToken() = runBlocking {
        val fixture = Fixture()
        fixture.service.responses += ListDataPointsResponse.newBuilder().setNextPageToken("same-token").build()
        fixture.service.responses += ListDataPointsResponse.newBuilder().setNextPageToken("same-token").build()

        val error = assertFailsWith<GoogleHealthHttpException> {
            fixture.client.fetchDataPoints("access-token", "steps", fixture.from, fixture.to, 1000)
        }

        assertEquals("google_health_pagination_loop", error.code)
    }

    @Test
    fun fetchDataPointsEnforcesPageLimit() = runBlocking {
        val fixture = Fixture(maxPages = 1)
        fixture.service.responses += ListDataPointsResponse.newBuilder().setNextPageToken("next").build()

        val error = assertFailsWith<GoogleHealthHttpException> {
            fixture.client.fetchDataPoints("access-token", "steps", fixture.from, fixture.to, 1000)
        }

        assertEquals("google_health_page_limit_exceeded", error.code)
    }

    @Test
    fun fetchDataPointsMapsUnauthenticatedToUnauthorizedException() = runBlocking {
        val fixture = Fixture()
        fixture.service.nextFailure = apiException(StatusCode.Code.UNAUTHENTICATED)

        assertFailsWith<GoogleHealthUnauthorizedException> {
            fixture.client.fetchDataPoints("access-token", "steps", fixture.from, fixture.to, 1000)
        }
        Unit
    }

    @Test
    fun fetchDataPointsMapsResourceExhaustedToUpstreamFailure() = runBlocking {
        val fixture = Fixture()
        fixture.service.nextFailure = apiException(StatusCode.Code.RESOURCE_EXHAUSTED)

        val error = assertFailsWith<GoogleHealthHttpException> {
            fixture.client.fetchDataPoints("access-token", "steps", fixture.from, fixture.to, 1000)
        }

        assertEquals("google_health_upstream_failed", error.code)
    }

    @Test
    fun fetchDataPointsRejectsUnsupportedDataType() = runBlocking {
        val fixture = Fixture()

        val error = assertFailsWith<GoogleHealthHttpException> {
            fixture.client.fetchDataPoints("access-token", "oxygen", fixture.from, fixture.to, 1000)
        }

        assertEquals("google_health_unsupported_data_type", error.code)
        assertTrue(fixture.service.requests.isEmpty())
    }

    private class Fixture(maxPages: Int = MAX_GOOGLE_HEALTH_PAGES) {
        val from: Instant = Instant.parse("2026-04-01T00:00:00Z")
        val to: Instant = Instant.parse("2026-04-02T00:00:00Z")
        val service = FakeDataPointsService()
        val client = GeneratedGoogleHealthClient(
            oauthClient = FakeOAuthClient(),
            dataPointsServiceFactory = object : GoogleHealthDataPointsServiceFactory() {
                override fun create(accessToken: String): GoogleHealthDataPointsService = service
            },
            maxPages = maxPages,
        )
    }

    private class FakeDataPointsService : GoogleHealthDataPointsService {
        val requests = mutableListOf<ListDataPointsRequest>()
        val responses = ArrayDeque<ListDataPointsResponse>()
        var nextFailure: ApiException? = null

        override fun listDataPoints(request: ListDataPointsRequest): ListDataPointsResponse {
            requests.add(request)
            nextFailure?.let {
                nextFailure = null
                throw it
            }
            return responses.removeFirst()
        }

        override fun close() = Unit
    }

    private class FakeOAuthClient : GoogleHealthClient {
        override suspend fun exchangeCode(code: String, now: Instant): GoogleHealthTokenSet = error("not used")
        override suspend fun refreshToken(refreshToken: String, now: Instant): GoogleHealthTokenSet = error("not used")
        override suspend fun fetchDataPoints(
            accessToken: String,
            dataType: String,
            from: Instant,
            to: Instant,
            pageSize: Int,
        ): GoogleHealthFetchResult = error("not used")
    }

    private fun apiException(code: StatusCode.Code): ApiException =
        ApiException("failure", null, object : StatusCode {
            override fun getCode(): StatusCode.Code = code
            override fun getTransportCode(): Any = code
        }, false)

    private fun stepsPoint(name: String = "google-steps-1"): DataPoint = dataPoint(
        """
        {
          "name": "$name",
          "steps": {
            "interval": {
              "startTime": "2026-04-01T08:00:00Z",
              "endTime": "2026-04-01T09:00:00Z"
            },
            "count": "1200"
          }
        }
        """
    )

    private fun sleepPoint(): DataPoint = dataPoint(
        """
        {
          "name": "google-sleep-1",
          "sleep": {
            "interval": {
              "startTime": "2026-03-31T22:00:00Z",
              "endTime": "2026-04-01T06:00:00Z"
            },
            "stages": [
              {
                "type": "LIGHT",
                "startTime": "2026-03-31T22:00:00Z",
                "endTime": "2026-04-01T01:00:00Z"
              }
            ]
          }
        }
        """
    )

    private fun heartRatePoint(): DataPoint = dataPoint(
        """
        {
          "name": "google-hr-1",
          "heartRate": {
            "sampleTime": {
              "physicalTime": "2026-04-01T08:30:00Z"
            },
            "beatsPerMinute": "62"
          }
        }
        """
    )

    private fun weightPoint(): DataPoint = dataPoint(
        """
        {
          "name": "google-weight-1",
          "weight": {
            "sampleTime": {
              "physicalTime": "2026-04-01T07:00:00Z"
            },
            "weightGrams": 82400.0
          }
        }
        """
    )

    private fun bodyFatPoint(): DataPoint = dataPoint(
        """
        {
          "name": "google-body-fat-1",
          "bodyFat": {
            "sampleTime": {
              "physicalTime": "2026-04-01T07:00:00Z"
            },
            "percentage": 18.2
          }
        }
        """
    )

    private fun dataPoint(json: String): DataPoint {
        val builder = DataPoint.newBuilder()
        JsonFormat.parser().merge(json.trimIndent(), builder)
        return builder.build()
    }
}

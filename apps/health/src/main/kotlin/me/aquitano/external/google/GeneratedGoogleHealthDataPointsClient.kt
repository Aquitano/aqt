package me.aquitano.external.google

import com.google.api.gax.core.FixedCredentialsProvider
import com.google.api.gax.rpc.ApiException
import com.google.api.gax.rpc.StatusCode
import com.google.auth.oauth2.AccessToken
import com.google.auth.oauth2.GoogleCredentials
import com.google.devicesandservices.health.v4.*
import com.google.protobuf.util.JsonFormat
import kotlinx.serialization.json.*
import me.aquitano.health.shared.AppJson
import io.github.oshai.kotlinlogging.KotlinLogging
import me.aquitano.health.infrastructure.logging.*
import java.time.Instant

private val generatedClientLogger = KotlinLogging.logger {}

class GeneratedGoogleHealthClient(
    private val oauthClient: GoogleHealthOAuthClient,
    private val dataPointsServiceFactory: GoogleHealthDataPointsServiceFactory = GoogleHealthDataPointsServiceFactory(),
    private val maxPages: Int = MAX_GOOGLE_HEALTH_PAGES,
) : GoogleHealthClient, GoogleHealthOAuthClient by oauthClient {
    override suspend fun fetchDataPoints(
        accessToken: String,
        dataType: String,
        from: Instant,
        to: Instant,
        pageSize: Int,
    ): GoogleHealthFetchResult {
        validateSupportedDataType(dataType)
        dataPointsServiceFactory.create(accessToken).use { service ->
            return fetchDataPoints(service, dataType, from, to, pageSize)
        }
    }

    private fun fetchDataPoints(
        service: GoogleHealthDataPointsService,
        dataType: String,
        from: Instant,
        to: Instant,
        pageSize: Int,
    ): GoogleHealthFetchResult {
        val pages = mutableListOf<GoogleHealthPage>()
        val dataPoints = mutableListOf<JsonObject>()
        val seenPageTokens = mutableSetOf<String>()
        var pageToken = ""
        var pageIndex = 0

        do {
            if (pageIndex >= maxPages) {
                throw GoogleHealthHttpException(
                    "google_health_page_limit_exceeded",
                    "Google Health $dataType pagination exceeded $maxPages pages",
                )
            }

            val request = ListDataPointsRequest.newBuilder()
                .setParent(DataTypeName.of("me", dataType).toString())
                .setPageSize(pageSize)
                .setFilter(filterFor(dataType, from, to))
                .also { builder ->
                    if (pageToken.isNotBlank()) builder.setPageToken(pageToken)
                }
                .build()

            val response = callListDataPoints(service, request, dataType)
            val pageDataPoints = response.dataPointsList.map(::dataPointJson)
            val nextPageToken =
                response.nextPageToken.takeIf { it.isNotBlank() }

            pages.add(
                GoogleHealthPage(
                    dataType = dataType,
                    pageIndex = pageIndex,
                    payload = buildJsonObject {
                        put("dataPoints", JsonArray(pageDataPoints))
                        put("nextPageToken", nextPageToken ?: "")
                    },
                )
            )
            dataPoints.addAll(pageDataPoints)
            pageIndex += 1

            if (pageIndex == 1 || pageIndex % 25 == 0) {
                generatedClientLogger.infoWithContext(
                    "google_health_generated_page_fetched",
                    "dataType" to dataType,
                    "pages" to pageIndex,
                    "dataPoints" to dataPoints.size,
                )
            }

            if (nextPageToken != null && !seenPageTokens.add(nextPageToken)) {
                throw GoogleHealthHttpException(
                    "google_health_pagination_loop",
                    "Google Health $dataType returned a repeated page token after $pageIndex pages",
                )
            }
            pageToken = nextPageToken.orEmpty()
        } while (pageToken.isNotBlank())

        return GoogleHealthFetchResult(dataType, pages, dataPoints)
    }

    private fun callListDataPoints(
        service: GoogleHealthDataPointsService,
        request: ListDataPointsRequest,
        dataType: String,
    ): ListDataPointsResponse =
        try {
            service.listDataPoints(request)
        } catch (exception: ApiException) {
            throw mapApiException(exception, dataType)
        }

    private fun mapApiException(
        exception: ApiException,
        dataType: String
    ): RuntimeException =
        when (exception.statusCode.code) {
            StatusCode.Code.UNAUTHENTICATED -> GoogleHealthUnauthorizedException(
                "Google Health access token is unauthorized"
            )

            StatusCode.Code.RESOURCE_EXHAUSTED,
            StatusCode.Code.UNAVAILABLE,
            StatusCode.Code.DEADLINE_EXCEEDED,
            StatusCode.Code.INTERNAL,
            StatusCode.Code.UNKNOWN,
                -> GoogleHealthHttpException(
                "google_health_upstream_failed",
                "Google Health $dataType request failed with ${exception.statusCode.code}"
            )

            else -> GoogleHealthHttpException(
                "google_health_upstream_failed",
                "Google Health $dataType request failed with ${exception.statusCode.code}"
            )
        }

    private fun validateSupportedDataType(dataType: String) {
        if (dataType !in GOOGLE_HEALTH_DEFAULT_DATA_TYPES) {
            throw GoogleHealthHttpException(
                "google_health_unsupported_data_type",
                "Unsupported Google Health data type: $dataType"
            )
        }
    }

    private fun filterFor(
        dataType: String,
        from: Instant,
        to: Instant
    ): String =
        when (dataType) {
            "steps" -> """steps.interval.start_time >= "$from" AND steps.interval.start_time < "$to""""
            "sleep" -> """sleep.interval.end_time >= "$from" AND sleep.interval.end_time < "$to""""
            "heart-rate" -> """heart_rate.sample_time.physical_time >= "$from" AND heart_rate.sample_time.physical_time < "$to""""
            "weight" -> """weight.sample_time.physical_time >= "$from" AND weight.sample_time.physical_time < "$to""""
            "body-fat" -> """body_fat.sample_time.physical_time >= "$from" AND body_fat.sample_time.physical_time < "$to""""
            else -> throw GoogleHealthHttpException(
                "google_health_unsupported_data_type",
                "Unsupported Google Health data type: $dataType"
            )
        }

    private fun dataPointJson(dataPoint: DataPoint): JsonObject =
        AppJson.parseToJsonElement(PROTO_JSON_PRINTER.print(dataPoint)).jsonObject

    companion object {
        private val PROTO_JSON_PRINTER: JsonFormat.Printer =
            JsonFormat.printer()
                .omittingInsignificantWhitespace()
    }
}

open class GoogleHealthDataPointsServiceFactory(
    private val apiBaseUrl: String? = null,
) {
    open fun create(accessToken: String): GoogleHealthDataPointsService =
        GeneratedGoogleHealthDataPointsService(accessToken, apiBaseUrl)
}

interface GoogleHealthDataPointsService : AutoCloseable {
    fun listDataPoints(request: ListDataPointsRequest): ListDataPointsResponse
}

private class GeneratedGoogleHealthDataPointsService(
    accessToken: String,
    apiBaseUrl: String?,
) : GoogleHealthDataPointsService {
    private val client = DataPointsServiceClient.create(
        dataPointsServiceSettings(
            accessToken,
            apiBaseUrl
        )
    )

    override fun listDataPoints(request: ListDataPointsRequest): ListDataPointsResponse =
        client.listDataPointsCallable().call(request)

    override fun close() {
        client.close()
    }
}

internal fun dataPointsServiceSettings(
    accessToken: String,
    apiBaseUrl: String? = null
): DataPointsServiceSettings {
    val builder = DataPointsServiceSettings.newHttpJsonBuilder()
        .setCredentialsProvider(
            FixedCredentialsProvider.create(
                GoogleCredentials.create(AccessToken(accessToken, null))
            )
        )
    apiBaseUrl?.toEndpoint()?.let(builder::setEndpoint)
    return builder.build()
}

private fun String.toEndpoint(): String =
    trim()
        .removePrefix("https://")
        .removePrefix("http://")
        .trimEnd('/')

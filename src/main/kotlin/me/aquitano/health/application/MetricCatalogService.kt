package me.aquitano.health.application

import me.aquitano.health.api.dto.*
import me.aquitano.health.domain.BodyMetricTypes

class MetricCatalogService(
    private val providerRegistry: HealthProviderRegistry,
) {
    fun catalog(): MetricCatalogResponseDto =
        MetricCatalogResponseDto(
            families = listOf(
                stepsCatalog(),
                sleepCatalog(),
                bodyMeasurementsCatalog(),
                heartRateCatalog(),
            ),
        )

    private fun stepsCatalog(): MetricFamilyCatalogDto =
        MetricFamilyCatalogDto(
            name = "steps",
            readEndpoints = listOf(
                endpoint("raw", "/api/v1/metrics/steps", "StepSamplesResponse"),
                endpoint(
                    "daily",
                    "/api/v1/metrics/steps/daily",
                    "StepDailySummariesResponse"
                ),
                endpoint(
                    "summary",
                    "/api/v1/dashboard/summary",
                    "DashboardSummaryResponse"
                ),
                endpoint(
                    "day",
                    "/api/v1/health/day",
                    "HealthDayResponse.steps"
                ),
            ),
            queryParameters = instantReadParameters() + dailyParameters() + dashboardParameters() + dayParameters("steps"),
            aggregationModes = listOf(
                mode("raw", "/api/v1/metrics/steps"),
                mode("daily", "/api/v1/metrics/steps/daily"),
                mode("summary", "/api/v1/dashboard/summary"),
                mode("day", "/api/v1/health/day"),
            ),
            responseDtos = listOf(
                "StepSamplesResponse",
                "StepDailySummariesResponse",
                "DashboardSummaryResponse.steps",
                "HealthDayResponse.steps",
            ),
            providerDataTypes = providerDataTypes(
                mapOf(
                    "google-health" to listOf("steps"),
                    "withings" to listOf("activity"),
                )
            ),
            schemaHint = "items contain step samples or UTC daily step summaries and list responses include meta with count, limit, sort, order, and no cursor for now; dashboard summary exposes total steps and sampleCount. The combined day endpoint accepts modules=steps and can be called with other modules in one request.",
        )

    private fun sleepCatalog(): MetricFamilyCatalogDto =
        MetricFamilyCatalogDto(
            name = "sleep",
            readEndpoints = listOf(
                endpoint(
                    "raw",
                    "/api/v1/sleep/sessions",
                    "SleepSessionsResponse"
                ),
                endpoint(
                    "latest",
                    "/api/v1/sleep/sessions",
                    "SleepSessionsResponse"
                ),
                endpoint(
                    "night",
                    "/api/v1/sleep/nights",
                    "SleepNightsResponse"
                ),
                endpoint(
                    "summary",
                    "/api/v1/dashboard/summary",
                    "DashboardSummaryResponse"
                ),
                endpoint(
                    "day",
                    "/api/v1/health/day",
                    "HealthDayResponse.sleep"
                ),
            ),
            queryParameters = instantReadParameters() + latestParameter() + sleepNightParameters() + dashboardParameters() + dayParameters("sleep"),
            aggregationModes = listOf(
                mode("raw", "/api/v1/sleep/sessions"),
                mode("latest", "/api/v1/sleep/sessions"),
                mode("night", "/api/v1/sleep/nights"),
                mode("summary", "/api/v1/dashboard/summary"),
                mode("day", "/api/v1/health/day"),
            ),
            responseDtos = listOf(
                "SleepSessionsResponse",
                "SleepNightsResponse",
                "DashboardSummaryResponse.lastSleepSession",
                "HealthDayResponse.sleep",
            ),
            providerDataTypes = providerDataTypes(
                mapOf(
                    "google-health" to listOf("sleep"),
                    "withings" to listOf("sleep", "sleep-summary"),
                )
            ),
            schemaHint = "raw items contain sleep sessions with nested stages and list responses include meta with count, limit, sort, order, and no cursor for now. Sleep nights classify complete sessions by the localized endAt date. The combined day endpoint accepts modules=sleep and can be called with other modules in one request.",
        )

    private fun bodyMeasurementsCatalog(): MetricFamilyCatalogDto =
        MetricFamilyCatalogDto(
            name = "body_measurements",
            readEndpoints = listOf(
                endpoint(
                    "raw",
                    "/api/v1/body/measurements",
                    "BodyMeasurementsResponse"
                ),
                endpoint(
                    "latest",
                    "/api/v1/body/measurements/latest",
                    "BodyMeasurementLatestResponse"
                ),
                endpoint(
                    "summary",
                    "/api/v1/dashboard/summary",
                    "DashboardSummaryResponse"
                ),
                endpoint(
                    "day",
                    "/api/v1/health/day",
                    "HealthDayResponse.weight"
                ),
            ),
            queryParameters = instantReadParameters() + latestParameter() + listOf(
                MetricQueryParameterDto(
                    name = "metricType",
                    type = "string",
                    description = "Body measurement type filter.",
                    values = BodyMetricTypes.supported.sorted(),
                ),
            ) + dashboardParameters() + dayParameters("weight"),
            aggregationModes = listOf(
                mode("raw", "/api/v1/body/measurements"),
                mode("latest", "/api/v1/body/measurements"),
                mode("summary", "/api/v1/dashboard/summary"),
                mode("day", "/api/v1/health/day"),
            ),
            metricTypes = BodyMetricTypes.supported.sorted(),
            responseDtos = listOf(
                "BodyMeasurementsResponse",
                "BodyMeasurementLatestResponse",
                "DashboardSummaryResponse.latestWeight",
                "HealthDayResponse.weight",
            ),
            providerDataTypes = providerDataTypes(
                mapOf(
                    "google-health" to listOf("weight", "body-fat"),
                    "withings" to listOf("measures"),
                )
            ),
            schemaHint = "items contain timestamped body measurements with metricType, value, and unit, and list responses include meta with count, limit, sort, order, and no cursor for now. The combined day endpoint accepts modules=weight and can be called with other modules in one request.",
        )

    private fun heartRateCatalog(): MetricFamilyCatalogDto =
        MetricFamilyCatalogDto(
            name = "heart_rate",
            readEndpoints = listOf(
                endpoint(
                    "raw",
                    "/api/v1/metrics/heart-rate",
                    "HeartRateSamplesResponse"
                ),
                endpoint(
                    "latest",
                    "/api/v1/metrics/heart-rate",
                    "HeartRateSamplesResponse"
                ),
                endpoint(
                    "summary",
                    "/api/v1/metrics/heart-rate/summary",
                    "HeartRateSummaryResponse"
                ),
                endpoint(
                    "day",
                    "/api/v1/health/day",
                    "HealthDayResponse.heartRate"
                ),
            ),
            queryParameters = instantReadParameters() + latestParameter() + dashboardParameters() + dayParameters("heartRate"),
            aggregationModes = listOf(
                mode("raw", "/api/v1/metrics/heart-rate"),
                mode("latest", "/api/v1/metrics/heart-rate"),
                mode("summary", "/api/v1/metrics/heart-rate/summary"),
                mode("day", "/api/v1/health/day"),
            ),
            responseDtos = listOf(
                "HeartRateSamplesResponse",
                "HeartRateSummaryResponse",
                "DashboardSummaryResponse.latestHeartRate",
                "HealthDayResponse.heartRate",
            ),
            providerDataTypes = providerDataTypes(
                mapOf(
                    "google-health" to listOf("heart-rate"),
                    "withings" to listOf("activity", "sleep"),
                )
            ),
            schemaHint = "items contain timestamped heart-rate samples with bpm and context, and list responses include meta with count, limit, sort, order, and no cursor for now. The combined day endpoint accepts modules=heartRate and can be called with other modules in one request.",
        )

    private fun endpoint(
        mode: String,
        path: String,
        responseDto: String,
    ): MetricReadEndpointDto =
        MetricReadEndpointDto(
            mode = mode,
            method = "GET",
            path = path,
            responseDto = responseDto,
        )

    private fun mode(name: String, endpoint: String): MetricAggregationModeDto =
        MetricAggregationModeDto(
            name = name,
            available = true,
            endpoint = endpoint,
        )

    private fun instantReadParameters(): List<MetricQueryParameterDto> =
        listOf(
            MetricQueryParameterDto(
                "from",
                "instant",
                description = "Inclusive start timestamp."
            ),
            MetricQueryParameterDto(
                "to",
                "instant",
                description = "Exclusive end timestamp."
            ),
            MetricQueryParameterDto(
                "provider",
                "string",
                description = "Source provider filter."
            ),
            MetricQueryParameterDto(
                "providerInstanceId",
                "string",
                description = "Source provider instance filter."
            ),
            MetricQueryParameterDto(
                "includeSource",
                "boolean",
                description = "Include source provider metadata."
            ),
            MetricQueryParameterDto(
                "limit",
                "integer",
                description = "Maximum items. Default 500, max 5000."
            ),
            MetricQueryParameterDto(
                "sort",
                "string",
                description = "Endpoint sort field. Supported values are the documented temporal or date field."
            ),
            MetricQueryParameterDto(
                "order",
                "asc | desc",
                description = "Sort direction. Default asc."
            ),
        )

    private fun dailyParameters(): List<MetricQueryParameterDto> =
        listOf(
            MetricQueryParameterDto(
                "date",
                "date | today",
                description = "Exact UTC date. Cannot be combined with fromDate or toDate."
            ),
            MetricQueryParameterDto(
                "fromDate",
                "date",
                description = "Inclusive UTC start date."
            ),
            MetricQueryParameterDto(
                "toDate",
                "date",
                description = "Inclusive UTC end date."
            ),
        )

    private fun sleepNightParameters(): List<MetricQueryParameterDto> =
        listOf(
            MetricQueryParameterDto(
                "date",
                "date | today",
                description = "Exact local sleep night date based on session endAt. Cannot be combined with fromDate or toDate."
            ),
            MetricQueryParameterDto(
                "fromDate",
                "date",
                description = "Inclusive local sleep-night start date based on session endAt."
            ),
            MetricQueryParameterDto(
                "toDate",
                "date",
                description = "Inclusive local sleep-night end date based on session endAt."
            ),
            MetricQueryParameterDto(
                "timezone",
                "IANA timezone",
                description = "Timezone used to classify sleep endAt dates. Default UTC."
            ),
        )

    private fun dashboardParameters(): List<MetricQueryParameterDto> =
        listOf(
            MetricQueryParameterDto(
                "fromDate",
                "date",
                required = true,
                description = "Inclusive UTC start date for dashboard summaries."
            ),
            MetricQueryParameterDto(
                "toDate",
                "date",
                required = true,
                description = "Inclusive UTC end date for dashboard summaries."
            ),
        )

    private fun dayParameters(module: String): List<MetricQueryParameterDto> =
        listOf(
            MetricQueryParameterDto(
                "date",
                "date | today",
                required = true,
                description = "Required local date for the combined day endpoint."
            ),
            MetricQueryParameterDto(
                "timezone",
                "IANA timezone",
                description = "Timezone used to calculate local day boundaries. Default UTC."
            ),
            MetricQueryParameterDto(
                "modules",
                "comma-separated string",
                required = true,
                description = "Requested combined day modules. This family uses `$module`; multiple modules can be requested in one call."
            ),
        )

    private fun latestParameter(): List<MetricQueryParameterDto> =
        listOf(
            MetricQueryParameterDto(
                "latest",
                "boolean",
                description = "Return the latest matching item when true."
            ),
        )

    private fun providerDataTypes(
        dataTypesByProvider: Map<String, List<String>>,
    ): List<MetricProviderDataTypesDto> =
        providerRegistry.listProviderDescriptors().mapNotNull { descriptor ->
            val dataTypes = dataTypesByProvider[descriptor.providerCode]
                ?.filter { it in descriptor.supportedDataTypes }
                .orEmpty()
            if (dataTypes.isEmpty()) {
                null
            } else {
                MetricProviderDataTypesDto(
                    providerCode = descriptor.providerCode,
                    dataTypes = dataTypes,
                )
            }
        }
}

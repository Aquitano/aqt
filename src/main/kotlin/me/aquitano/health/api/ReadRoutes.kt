@file:OptIn(io.ktor.utils.io.ExperimentalKtorApi::class)

package me.aquitano.health.api

import io.ktor.http.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.routing.openapi.*
import me.aquitano.health.api.dto.*
import me.aquitano.health.application.SleepSummaryReadService
import me.aquitano.health.application.TrendQueryService
import me.aquitano.health.application.HealthDayQueryService
import me.aquitano.health.application.metric.activity.ActivityQueryService
import me.aquitano.health.application.metric.cardiovascular.CardiovascularQueryService
import me.aquitano.health.application.metric.common.QueryParamSpecs
import me.aquitano.health.application.metric.dashboard.DashboardQueryService
import me.aquitano.health.application.metric.scalar.ScalarMetricQueryService
import me.aquitano.health.application.metric.sleep.SleepQueryService
import me.aquitano.health.application.metric.steps.StepQueryService
import me.aquitano.health.domain.NotFoundException
import me.aquitano.health.infrastructure.time.UtcClock
import org.koin.ktor.ext.inject
import kotlin.reflect.typeOf

/** Metric catalog, scalar/structural metric, health-day, and dashboard read routes. */
internal fun Route.readRoutes() {
    val clock by application.inject<UtcClock>()
    val scalarMetricQueryService by application.inject<ScalarMetricQueryService>()
    val healthDayQueryService by application.inject<HealthDayQueryService>()
    val stepQueryService by application.inject<StepQueryService>()
    val activityQueryService by application.inject<ActivityQueryService>()
    val sleepQueryService by application.inject<SleepQueryService>()
    val sleepSummaryReadService by application.inject<SleepSummaryReadService>()
    val cardiovascularQueryService by application.inject<CardiovascularQueryService>()
    val dashboardQueryService by application.inject<DashboardQueryService>()
    val trendQueryService by application.inject<TrendQueryService>()

    get("/api/v2/metrics") {
        call.respond<MetricTypeCatalogResponse>(scalarMetricQueryService.catalog())
    }.describe {
        operationId = "getMetricTypeCatalog"
        tag("Read")
        summary = "List readable scalar metric types"
        description =
            "Returns every scalar metric type the API can serve, with family, unit, segment support, and allowed context values. Structural metrics (steps, sleep, activity, blood pressure) have dedicated endpoints."
        requiresBearerAuth()
        errorResponses()
    }
    get("/api/v2/metrics/{metricType}") {
        call.respond<ScalarSamplesResponse>(
            scalarMetricQueryService.list(
                call.metricTypePath(),
                call.queryParams(),
            )
        )
    }.describe {
        operationId = "listScalarSamples"
        tag("Read")
        summary = "List scalar samples for one metric type"
        description =
            "Returns canonical (cross-provider deduplicated) samples for the metric type; `raw=true` returns every stored sample instead. Supports `latest=true` for the newest matching sample and opaque `cursor` keyset pagination via `meta.nextCursor`. Unknown metric types return 404."
        requiresBearerAuth()
        scalarMetricQueryParameters()
        errorResponses(notFound = true)
    }
    get("/api/v2/metrics/{metricType}/summary") {
        call.respond<ScalarSummaryResponse>(
            scalarMetricQueryService.summary(
                call.metricTypePath(),
                call.queryParams(),
            )
        )
    }.describe {
        operationId = "summarizeScalarSamples"
        tag("Read")
        summary = "Summarize scalar samples for one metric type"
        description =
            "Returns count, minimum, maximum, average, and the latest canonical sample for the metric type within the requested timestamp and source filters. Unknown metric types return 404."
        requiresBearerAuth()
        scalarSummaryQueryParameters()
        errorResponses(notFound = true)
    }
    get("/api/v2/metrics/{metricType}/daily") {
        call.respond<ScalarDailySummariesResponse>(
            scalarMetricQueryService.summaryDaily(
                call.metricTypePath(),
                call.queryParams(),
            )
        )
    }.describe {
        operationId = "summarizeScalarSamplesDaily"
        tag("Read")
        summary = "Summarize scalar samples per calendar day"
        description =
            "Returns one count/min/max/avg bucket per calendar day for the metric type within the requested timestamp range, grouped by the `timezone` day boundaries (UTC by default). At least one of `from`/`to` is required to bound the scan. Replaces per-day summary fan-out with a single ranged read. Unknown metric types return 404."
        requiresBearerAuth()
        scalarDailySummaryQueryParameters()
        errorResponses(notFound = true)
    }
    get("/api/v2/health/day") {
        call.respond<HealthDayResponse>(
            HttpStatusCode.OK,
            healthDayQueryService.getHealthDay(
                call.queryParams(),
                clock.now(),
            )
        )
    }.describe {
        operationId = "getHealthDay"
        tag("Read")
        summary = "Get modular one-day health data"
        description =
            "Returns only the requested one-day health modules for a local day. The `timezone` parameter defines the local-day UTC boundaries. Normalized data is merged across providers by default; provider and providerInstanceId narrow the source set, and includeSource attaches provider metadata to point-level objects where available."
        requiresBearerAuth()
        healthDayQueryParameters()
        responses {
            HttpStatusCode.OK {
                description = "Requested day modules"
                content {
                    schema = buildSchema(typeOf<HealthDayResponse>())
                }
            }
            commonErrors()
            defaultError()
        }
    }
    get("/api/v2/steps") {
        call.respond<StepSamplesResponse>(
            stepQueryService.listStepSamples(
                call.queryParams()
            )
        )
    }.describeReadOperation(
        operationId = "listStepSamples",
        summary = "List step samples",
        descriptionText = "Returns canonical step samples filtered by timestamp range, source provider, provider instance, source metadata inclusion, item limit, and sort order. Use `latest=true` to return the latest matching sample only.",
        includeLatest = true,
        sortSpec = QueryParamSpecs.sortByStartAt,
    )
    get("/api/v2/steps/daily") {
        call.respond<StepDailySummariesResponse>(
            HttpStatusCode.OK,
            stepQueryService.listStepDailySummaries(
                call.queryParams(),
                clock.now()
            )
        )
    }.describeDailyStepReadOperation()
    get("/api/v2/activity/summaries") {
        call.respond<ActivitySummariesResponse>(
            HttpStatusCode.OK,
            activityQueryService.listActivitySummaries(
                call.queryParams(),
                clock.now()
            )
        )
    }.describeActivitySummaryReadOperation()
    get("/api/v2/sleep/sessions") {
        call.respond<SleepSessionsResponse>(
            sleepQueryService.listSleepSessions(
                call.queryParams()
            )
        )
    }.describeReadOperation(
        operationId = "listSleepSessions",
        summary = "List sleep sessions",
        descriptionText = "Returns sleep sessions with nested stages. Use `latest=true` to return the latest matching session only.",
        includeLatest = true,
        sortSpec = QueryParamSpecs.sortByStartAt,
    )
    get("/api/v2/sleep/nights") {
        call.respond<SleepNightsResponse>(
            HttpStatusCode.OK,
            sleepQueryService.listSleepNights(
                call.queryParams(),
                clock.now()
            )
        )
    }.describeSleepNightReadOperation()
    get("/api/v2/sleep/summaries") {
        call.respond<SleepSummariesResponse>(
            sleepSummaryReadService.list(
                call.queryParams()
            )
        )
    }.describeReadOperation(
        operationId = "listSleepSummaries",
        summary = "List sleep summaries",
        descriptionText = "Returns aggregate sleep summary records such as sleep score, efficiency, latency, wakeups, WASO, and stage-duration totals. Use `latest=true` to return the latest matching summary only.",
        includeLatest = true,
        sortSpec = QueryParamSpecs.sortByEndAt,
    )
    get("/api/v2/blood-pressure") {
        call.respond<BloodPressureMeasurementsResponse>(
            cardiovascularQueryService.listBloodPressure(call.queryParams())
        )
    }.describeReadOperation(
        operationId = "listBloodPressureMeasurements",
        summary = "List blood pressure measurements",
        descriptionText = "Returns paired systolic/diastolic blood-pressure measurements filtered by timestamp and source. Use `latest=true` to return the latest matching measurement only.",
        includeLatest = true,
        sortSpec = QueryParamSpecs.sortByMeasuredAt,
    )

    get("/api/v2/dashboard/summary") {
        call.respond<DashboardSummaryResponse>(
            HttpStatusCode.OK,
            dashboardQueryService.dashboardSummary(
                call.queryParams(),
                clock.now()
            )
        )
    }.describe {
        operationId = "getDashboardSummary"
        tag("Read")
        summary = "Get dashboard summary"
        description =
            "Returns aggregate dashboard data for an inclusive UTC date range, including total steps and latest matching weight, heart-rate, and sleep values."
        requiresBearerAuth()
        dashboardQueryParameters()
        errorResponses()
    }
    get("/api/v2/dashboard/trends") {
        call.respond<DashboardTrendsResponse>(
            HttpStatusCode.OK,
            trendQueryService.dashboardTrends(
                call.queryParams(),
                clock.now(),
            )
        )
    }.describe {
        operationId = "getDashboardTrends"
        tag("Read")
        summary = "Get dashboard trends"
        description =
            "Returns trend comparisons for steps, heart rate, sleep, and weight over a configurable period compared to the preceding period."
        requiresBearerAuth()
        parameters {
            query("periodDays") {
                description = "Number of days in the comparison period"
                schema = integerSchema(minimum = 1.0, maximum = 90.0, example = 7)
            }
            query("toDate") {
                description = "End date of current period (ISO-8601 date); defaults to today"
                schema = stringSchema(format = "date", example = "2026-05-30")
            }
        }
        errorResponses()
    }
}

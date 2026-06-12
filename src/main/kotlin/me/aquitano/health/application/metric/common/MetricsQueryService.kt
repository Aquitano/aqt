package me.aquitano.health.application.metric.common

import me.aquitano.health.api.dto.*
import me.aquitano.health.application.metric.activity.ActivityQueryService
import me.aquitano.health.application.metric.cardiovascular.CardiovascularQueryService
import me.aquitano.health.application.metric.dashboard.DashboardQueryService
import me.aquitano.health.application.metric.sleep.SleepQueryService
import me.aquitano.health.application.metric.steps.StepQueryService
import java.time.Instant

/**
 * Facade that delegates the structural metric read operations to the appropriate
 * per-metric query service; scalar metrics are served by ScalarMetricQueryService.
 */
class MetricsQueryService(
    private val activityQueryService: ActivityQueryService,
    private val stepQueryService: StepQueryService,
    private val sleepQueryService: SleepQueryService,
    private val cardiovascularQueryService: CardiovascularQueryService,
    private val dashboardQueryService: DashboardQueryService,
) {
    suspend fun listActivitySummaries(
        params: QueryParams,
        now: Instant,
    ): ActivitySummariesResponse =
        activityQueryService.listActivitySummaries(params, now)

    suspend fun listStepSamples(params: QueryParams): StepSamplesResponse =
        stepQueryService.listStepSamples(params)

    suspend fun listStepDailySummaries(
        params: QueryParams,
        now: Instant,
    ): StepDailySummariesResponse =
        stepQueryService.listStepDailySummaries(params, now)

    suspend fun listSleepSessions(params: QueryParams): SleepSessionsResponse =
        sleepQueryService.listSleepSessions(params)

    suspend fun listSleepNights(
        params: QueryParams,
        now: Instant,
    ): SleepNightsResponse =
        sleepQueryService.listSleepNights(params, now)

    suspend fun listBloodPressure(params: QueryParams): BloodPressureMeasurementsResponse =
        cardiovascularQueryService.listBloodPressure(params)

    suspend fun dashboardSummary(
        params: QueryParams,
        now: Instant,
    ): DashboardSummaryResponse =
        dashboardQueryService.dashboardSummary(params, now)
}

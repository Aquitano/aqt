package me.aquitano.health.application.metric.common

import me.aquitano.health.api.dto.*
import me.aquitano.health.application.metric.activity.ActivityQueryService
import me.aquitano.health.application.metric.body.BodyMeasurementQueryService
import me.aquitano.health.application.metric.cardiovascular.CardiovascularQueryService
import me.aquitano.health.application.metric.dashboard.DashboardQueryService
import me.aquitano.health.application.metric.heart.HeartRateQueryService
import me.aquitano.health.application.metric.hrv.HrvQueryService
import me.aquitano.health.application.metric.respiratory.RespiratoryRateQueryService
import me.aquitano.health.application.metric.sleep.SleepQueryService
import me.aquitano.health.application.metric.steps.StepQueryService
import java.time.Instant

/**
 * Facade that delegates all metric read operations to the appropriate
 * per-metric query service.  Instances are assembled by Koin with each
 * sub-service injected from the container.
 */
class MetricsQueryService(
    private val activityQueryService: ActivityQueryService,
    private val stepQueryService: StepQueryService,
    private val sleepQueryService: SleepQueryService,
    private val bodyMeasurementQueryService: BodyMeasurementQueryService,
    private val heartRateQueryService: HeartRateQueryService,
    private val respiratoryRateQueryService: RespiratoryRateQueryService,
    private val hrvQueryService: HrvQueryService,
    private val cardiovascularQueryService: CardiovascularQueryService,
    private val dashboardQueryService: DashboardQueryService,
) {
    suspend fun listActivitySummaries(
        params: QueryParams,
        now: Instant,
    ): ActivitySummariesResponse =
        activityQueryService.listActivitySummaries(params, now)

    suspend fun latestActivitySummary(
        params: QueryParams,
        now: Instant,
    ): ActivitySummaryLatestResponse =
        activityQueryService.latestActivitySummary(params, now)

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

    suspend fun listBodyMeasurements(params: QueryParams): BodyMeasurementsResponse =
        bodyMeasurementQueryService.listBodyMeasurements(params)

    suspend fun latestBodyMeasurement(params: QueryParams): BodyMeasurementLatestResponse =
        bodyMeasurementQueryService.latestBodyMeasurement(params)

    suspend fun listHeartRateSamples(params: QueryParams): HeartRateSamplesResponse =
        heartRateQueryService.listHeartRateSamples(params)

    suspend fun heartRateSummary(params: QueryParams): HeartRateSummaryResponse =
        heartRateQueryService.heartRateSummary(params)

    suspend fun listRespiratoryRateSamples(params: QueryParams): RespiratoryRateSamplesResponse =
        respiratoryRateQueryService.listRespiratoryRateSamples(params)

    suspend fun respiratoryRateSummary(params: QueryParams): RespiratoryRateSummaryResponse =
        respiratoryRateQueryService.respiratoryRateSummary(params)

    suspend fun listHrvSamples(params: QueryParams): HrvSamplesResponse =
        hrvQueryService.listHrvSamples(params)

    suspend fun hrvSummary(params: QueryParams): HrvSummaryResponse =
        hrvQueryService.hrvSummary(params)

    suspend fun listBloodPressure(params: QueryParams): BloodPressureMeasurementsResponse =
        cardiovascularQueryService.listBloodPressure(params)

    suspend fun latestBloodPressure(params: QueryParams): BloodPressureLatestResponse =
        cardiovascularQueryService.latestBloodPressure(params)

    suspend fun listCardiovascular(params: QueryParams): CardiovascularMeasurementsResponse =
        cardiovascularQueryService.listCardiovascular(params)

    suspend fun latestCardiovascular(params: QueryParams): CardiovascularMeasurementResponse =
        cardiovascularQueryService.latestCardiovascular(params)

    suspend fun listExtendedBodyMeasurements(params: QueryParams): ExtendedBodyMeasurementsResponse =
        bodyMeasurementQueryService.listExtendedBodyMeasurements(params)

    suspend fun latestExtendedBodyMeasurement(params: QueryParams): ExtendedBodyMeasurementResponse =
        bodyMeasurementQueryService.latestExtendedBodyMeasurement(params)

    suspend fun dashboardSummary(
        params: QueryParams,
        now: Instant,
    ): DashboardSummaryResponse =
        dashboardQueryService.dashboardSummary(params, now)
}

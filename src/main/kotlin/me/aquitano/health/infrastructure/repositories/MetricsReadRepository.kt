package me.aquitano.health.infrastructure.repositories

import me.aquitano.health.application.metric.activity.repository.ActivitySummaryRepository
import me.aquitano.health.application.metric.body.repository.BodyMeasurementRepository
import me.aquitano.health.application.metric.cardiovascular.repository.CardiovascularRepository
import me.aquitano.health.application.metric.common.MetricReadRepository
import me.aquitano.health.application.metric.heart.repository.HeartRateRepository
import me.aquitano.health.application.metric.hrv.repository.HrvRepository
import me.aquitano.health.application.metric.respiratory.repository.RespiratoryRateRepository
import me.aquitano.health.application.metric.sleep.repository.SleepRepository
import me.aquitano.health.application.metric.steps.repository.StepRepository
import java.time.Instant

typealias SourceMetadata = me.aquitano.health.application.metric.common.repository.SourceMetadata
typealias ReadFilters = me.aquitano.health.application.metric.common.repository.ReadFilters
typealias DailyReadFilters = me.aquitano.health.application.metric.common.repository.DailyReadFilters
typealias SleepNightReadFilters = me.aquitano.health.application.metric.common.repository.SleepNightReadFilters
typealias StepSampleRow = me.aquitano.health.application.metric.steps.repository.StepSampleRow
typealias StepDailySummaryRow = me.aquitano.health.application.metric.steps.repository.StepDailySummaryRow
typealias SleepSessionRow = me.aquitano.health.application.metric.sleep.repository.SleepSessionRow
typealias SleepNightRow = me.aquitano.health.application.metric.sleep.repository.SleepNightRow
typealias SleepStageRow = me.aquitano.health.application.metric.sleep.repository.SleepStageRow
typealias BodyMeasurementRow = me.aquitano.health.application.metric.body.repository.BodyMeasurementRow
typealias ActivitySummaryRow = me.aquitano.health.application.metric.activity.repository.ActivitySummaryRow
typealias SleepSummaryRow = me.aquitano.health.application.metric.sleep.repository.SleepSummaryRow
typealias HeartRateSampleRow = me.aquitano.health.application.metric.heart.repository.HeartRateSampleRow
typealias RespiratoryRateSampleRow = me.aquitano.health.application.metric.respiratory.repository.RespiratoryRateSampleRow
typealias BloodPressureMeasurementRow = me.aquitano.health.application.metric.cardiovascular.repository.BloodPressureMeasurementRow
typealias CardiovascularMeasurementRow = me.aquitano.health.application.metric.cardiovascular.repository.CardiovascularMeasurementRow
typealias ExtendedBodyMeasurementRow = me.aquitano.health.application.metric.body.repository.ExtendedBodyMeasurementRow
typealias HrvSampleRow = me.aquitano.health.application.metric.hrv.repository.HrvSampleRow
typealias DashboardStepsSummaryRow = me.aquitano.health.application.metric.steps.repository.DashboardStepsSummaryRow
typealias HeartRateSummaryRow = me.aquitano.health.application.metric.heart.repository.HeartRateSummaryRow
typealias RespiratoryRateSummaryRow = me.aquitano.health.application.metric.respiratory.repository.RespiratoryRateSummaryRow
typealias HrvSummaryRow = me.aquitano.health.application.metric.hrv.repository.HrvSummaryRow

class MetricsReadRepository(
    private val activity: ActivitySummaryRepository = ActivitySummaryRepository(),
    private val steps: StepRepository = StepRepository(),
    private val sleep: SleepRepository = SleepRepository(),
    private val body: BodyMeasurementRepository = BodyMeasurementRepository(),
    private val heartRate: HeartRateRepository = HeartRateRepository(),
    private val respiratoryRate: RespiratoryRateRepository = RespiratoryRateRepository(),
    private val hrv: HrvRepository = HrvRepository(),
    private val cardiovascular: CardiovascularRepository = CardiovascularRepository(),
) : MetricReadRepository {
    override fun sourceMetadataFor(sourceIds: Set<Int>): Map<Int, SourceMetadata> =
        steps.sourceMetadataFor(sourceIds)

    fun listActivitySummaries(filters: DailyReadFilters) = activity.listActivitySummaries(filters)
    fun latestActivitySummary(filters: DailyReadFilters) = activity.latestActivitySummary(filters)
    fun listStepSamples(filters: ReadFilters) = steps.listStepSamples(filters)
    fun listStepSamplesForWindow(filters: ReadFilters) = steps.listStepSamplesForWindow(filters)
    fun listStepDailySummaries(filters: DailyReadFilters) = steps.listStepDailySummaries(filters)
    fun sumStepDailySummaries(filters: DailyReadFilters) = steps.sumStepDailySummaries(filters)
    fun listSleepSessions(filters: ReadFilters) = sleep.listSleepSessions(filters)
    fun listSleepSessionsOverlappingWindow(filters: ReadFilters) = sleep.listSleepSessionsOverlappingWindow(filters)
    fun listSleepNights(filters: SleepNightReadFilters) = sleep.listSleepNights(filters)
    fun latestSleepSession(filters: ReadFilters) = sleep.latestSleepSession(filters)
    fun listSleepSummaries(filters: ReadFilters) = sleep.listSleepSummaries(filters)
    fun latestSleepSummary(filters: ReadFilters) = sleep.latestSleepSummary(filters)
    fun avgSleepDuration(filters: ReadFilters) = sleep.avgSleepDuration(filters)
    fun listBodyMeasurements(filters: ReadFilters, metricType: String?) = body.listBodyMeasurements(filters, metricType)
    fun listBodyMeasurementsForWindow(filters: ReadFilters, metricType: String) = body.listBodyMeasurementsForWindow(filters, metricType)
    fun latestBodyMeasurementBefore(filters: ReadFilters, metricType: String) = body.latestBodyMeasurementBefore(filters, metricType)
    fun latestBodyMeasurementsBefore(filters: ReadFilters, metricType: String) = body.latestBodyMeasurementsBefore(filters, metricType)
    fun latestBodyMeasurement(filters: ReadFilters, metricType: String) = body.latestBodyMeasurement(filters, metricType)
    fun latestBodyMeasurementBefore(before: Instant, metricType: String) = body.latestBodyMeasurementBefore(before, metricType)
    fun listExtendedBodyMeasurements(filters: ReadFilters, metricType: String?) = body.listExtendedBodyMeasurements(filters, metricType)
    fun listExtendedBodyMeasurementsForWindow(filters: ReadFilters, metricType: String) = body.listExtendedBodyMeasurementsForWindow(filters, metricType)
    fun latestExtendedBodyMeasurementBefore(filters: ReadFilters, metricType: String) = body.latestExtendedBodyMeasurementBefore(filters, metricType)
    fun listHeartRateSamples(filters: ReadFilters) = heartRate.listHeartRateSamples(filters)
    fun listHeartRateSamplesForWindow(filters: ReadFilters) = heartRate.listHeartRateSamplesForWindow(filters)
    fun latestHeartRateSample(filters: ReadFilters) = heartRate.latestHeartRateSample(filters)
    fun summarizeHeartRate(filters: ReadFilters) = heartRate.summarizeHeartRate(filters)
    fun summarizeHeartRateForWindow(filters: ReadFilters) = heartRate.summarizeHeartRateForWindow(filters)
    fun listRespiratoryRateSamples(filters: ReadFilters) = respiratoryRate.listRespiratoryRateSamples(filters)
    fun latestRespiratoryRateSample(filters: ReadFilters) = respiratoryRate.latestRespiratoryRateSample(filters)
    fun summarizeRespiratoryRate(filters: ReadFilters) = respiratoryRate.summarizeRespiratoryRate(filters)
    fun listHrvSamples(filters: ReadFilters, metricType: String) = hrv.listHrvSamples(filters, metricType)
    fun latestHrvSample(filters: ReadFilters, metricType: String) = hrv.latestHrvSample(filters, metricType)
    fun summarizeHrv(filters: ReadFilters, metricType: String) = hrv.summarizeHrv(filters, metricType)
    fun listBloodPressure(filters: ReadFilters) = cardiovascular.listBloodPressure(filters)
    fun latestBloodPressure(filters: ReadFilters) = cardiovascular.latestBloodPressure(filters)
    fun listCardiovascular(filters: ReadFilters, metricType: String?) = cardiovascular.listCardiovascular(filters, metricType)
    fun latestCardiovascular(filters: ReadFilters, metricType: String) = cardiovascular.latestCardiovascular(filters, metricType)
}

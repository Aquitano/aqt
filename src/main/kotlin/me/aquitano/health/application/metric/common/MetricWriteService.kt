package me.aquitano.health.application.metric.common

import me.aquitano.health.application.metric.activity.repository.ActivitySummaryWriteRepository
import me.aquitano.health.application.metric.body.repository.BodyMeasurementWriteRepository
import me.aquitano.health.application.metric.cardiovascular.repository.CardiovascularWriteRepository
import me.aquitano.health.application.metric.heart.repository.HeartRateWriteRepository
import me.aquitano.health.application.metric.hrv.repository.HrvWriteRepository
import me.aquitano.health.application.metric.respiratory.repository.RespiratoryRateWriteRepository
import me.aquitano.health.application.metric.sleep.repository.SleepWriteRepository
import me.aquitano.health.application.metric.steps.repository.StepWriteRepository
import me.aquitano.health.domain.ActivitySummaryRecord
import me.aquitano.health.domain.BloodPressureRecord
import me.aquitano.health.domain.BodyMeasurementRecord
import me.aquitano.health.domain.CardiovascularRecord
import me.aquitano.health.domain.ExtendedBodyMeasurementRecord
import me.aquitano.health.domain.HealthRecord
import me.aquitano.health.domain.HeartRateRecord
import me.aquitano.health.domain.HrvRecord
import me.aquitano.health.domain.MetricCreatedCounts
import me.aquitano.health.domain.RespiratoryRateRecord
import me.aquitano.health.domain.SleepSessionRecord
import me.aquitano.health.domain.SleepSummaryRecord
import me.aquitano.health.domain.StepIntervalRecord
import me.aquitano.health.shared.utcDate
import java.time.Instant
import java.time.LocalDate

class MetricWriteService(
    private val stepWriteRepository: StepWriteRepository = StepWriteRepository(),
    private val sleepWriteRepository: SleepWriteRepository = SleepWriteRepository(),
    private val bodyMeasurementWriteRepository: BodyMeasurementWriteRepository = BodyMeasurementWriteRepository(),
    private val heartRateWriteRepository: HeartRateWriteRepository = HeartRateWriteRepository(),
    private val activitySummaryWriteRepository: ActivitySummaryWriteRepository = ActivitySummaryWriteRepository(),
    private val respiratoryRateWriteRepository: RespiratoryRateWriteRepository = RespiratoryRateWriteRepository(),
    private val hrvWriteRepository: HrvWriteRepository = HrvWriteRepository(),
    private val cardiovascularWriteRepository: CardiovascularWriteRepository = CardiovascularWriteRepository(),
) {
    fun write(
        provider: String,
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: HealthRecord,
        now: Instant,
    ): MetricWriteResult =
        when (record) {
            is StepIntervalRecord -> writeStepInterval(
                provider,
                sourceInstanceId,
                ingestionRecordId,
                record,
                now,
            )

            is SleepSessionRecord -> writeSleepSession(
                sourceInstanceId,
                ingestionRecordId,
                record,
                now,
            )

            is BodyMeasurementRecord -> writeBodyMeasurement(
                sourceInstanceId,
                ingestionRecordId,
                record,
                now,
            )

            is HeartRateRecord -> writeHeartRate(
                sourceInstanceId,
                ingestionRecordId,
                record,
                now,
            )

            is ActivitySummaryRecord -> writeActivitySummary(
                sourceInstanceId,
                ingestionRecordId,
                record,
                now,
            )

            is SleepSummaryRecord -> writeSleepSummary(
                sourceInstanceId,
                ingestionRecordId,
                record,
                now,
            )

            is RespiratoryRateRecord -> writeRespiratoryRate(
                sourceInstanceId,
                ingestionRecordId,
                record,
                now,
            )

            is HrvRecord -> writeHrv(
                sourceInstanceId,
                ingestionRecordId,
                record,
                now,
            )

            is BloodPressureRecord -> writeBloodPressure(
                sourceInstanceId,
                ingestionRecordId,
                record,
                now,
            )

            is CardiovascularRecord -> writeCardiovascular(
                sourceInstanceId,
                ingestionRecordId,
                record,
                now,
            )

            is ExtendedBodyMeasurementRecord -> writeExtendedBodyMeasurement(
                sourceInstanceId,
                ingestionRecordId,
                record,
                now,
            )
        }

    private fun writeStepInterval(
        provider: String,
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: StepIntervalRecord,
        now: Instant,
    ): MetricWriteResult {
        val inserted = stepWriteRepository.insertStepSample(
            provider,
            sourceInstanceId,
            ingestionRecordId,
            record,
            now,
        )
        return if (inserted) {
            MetricWriteResult(
                created = MetricCreatedCounts(stepSamples = 1),
                affectedStepSummaryDates = affectedUtcDates(
                    record.startAt,
                    record.endAt,
                ),
            )
        } else {
            MetricWriteResult(duplicateSkipped = 1)
        }
    }

    private fun writeSleepSession(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: SleepSessionRecord,
        now: Instant,
    ): MetricWriteResult {
        val sessionId = sleepWriteRepository.insertSleepSession(
            sourceInstanceId,
            ingestionRecordId,
            record,
            now,
        )
        return if (sessionId != null) {
            MetricWriteResult(
                created = MetricCreatedCounts(
                    sleepSessions = 1,
                    sleepStages = record.stages.size,
                ),
                affectedSleepNightDates = setOf(record.endAt.utcDate()),
            )
        } else {
            MetricWriteResult(duplicateSkipped = 1)
        }
    }

    private fun writeBodyMeasurement(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: BodyMeasurementRecord,
        now: Instant,
    ): MetricWriteResult {
        val inserted = bodyMeasurementWriteRepository.insertBodyMeasurements(
            sourceInstanceId,
            ingestionRecordId,
            record,
            now,
        )
        return MetricWriteResult(
            created = MetricCreatedCounts(bodyMeasurements = inserted),
            duplicateSkipped = record.measurements.size - inserted,
            affectedBodyMeasurementCanonicalDates =
                if (inserted > 0) setOf(record.measuredAt.utcDate()) else emptySet(),
        )
    }

    private fun writeHeartRate(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: HeartRateRecord,
        now: Instant,
    ): MetricWriteResult {
        val inserted = heartRateWriteRepository.insertHeartRateSample(
            sourceInstanceId,
            ingestionRecordId,
            record,
            now,
        )
        return if (inserted) {
            MetricWriteResult(
                created = MetricCreatedCounts(heartRateSamples = 1),
                affectedHeartRateCanonicalDates = setOf(record.measuredAt.utcDate()),
            )
        } else {
            MetricWriteResult(duplicateSkipped = 1)
        }
    }

    private fun writeActivitySummary(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: ActivitySummaryRecord,
        now: Instant,
    ): MetricWriteResult {
        val inserted = activitySummaryWriteRepository.insertActivitySummary(
            sourceInstanceId,
            ingestionRecordId,
            record,
            now,
        )
        return if (inserted) {
            MetricWriteResult(created = MetricCreatedCounts(activitySummaries = 1))
        } else {
            MetricWriteResult(duplicateSkipped = 1)
        }
    }

    private fun writeSleepSummary(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: SleepSummaryRecord,
        now: Instant,
    ): MetricWriteResult {
        val inserted = sleepWriteRepository.insertSleepSummary(
            sourceInstanceId,
            ingestionRecordId,
            record,
            now,
        )
        return if (inserted) {
            MetricWriteResult(
                created = MetricCreatedCounts(sleepSummaries = 1),
                affectedSleepSummaryCanonicalDates = setOf(record.startAt.utcDate()),
            )
        } else {
            MetricWriteResult(duplicateSkipped = 1)
        }
    }

    private fun writeRespiratoryRate(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: RespiratoryRateRecord,
        now: Instant,
    ): MetricWriteResult {
        val inserted = respiratoryRateWriteRepository.insertRespiratoryRateSample(
            sourceInstanceId,
            ingestionRecordId,
            record,
            now,
        )
        return if (inserted) {
            MetricWriteResult(
                created = MetricCreatedCounts(respiratoryRateSamples = 1),
                affectedRespiratoryRateCanonicalDates = setOf(record.measuredAt.utcDate()),
            )
        } else {
            MetricWriteResult(duplicateSkipped = 1)
        }
    }

    private fun writeHrv(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: HrvRecord,
        now: Instant,
    ): MetricWriteResult {
        val inserted = hrvWriteRepository.insertHrvSample(
            sourceInstanceId,
            ingestionRecordId,
            record,
            now,
        )
        return if (inserted) {
            MetricWriteResult(
                created = MetricCreatedCounts(hrvSamples = 1),
                affectedHrvCanonicalDates = setOf(record.measuredAt.utcDate()),
            )
        } else {
            MetricWriteResult(duplicateSkipped = 1)
        }
    }

    private fun writeBloodPressure(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: BloodPressureRecord,
        now: Instant,
    ): MetricWriteResult {
        val inserted = cardiovascularWriteRepository.insertBloodPressure(
            sourceInstanceId,
            ingestionRecordId,
            record,
            now,
        )
        return if (inserted) {
            MetricWriteResult(created = MetricCreatedCounts(bloodPressureMeasurements = 1))
        } else {
            MetricWriteResult(duplicateSkipped = 1)
        }
    }

    private fun writeCardiovascular(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: CardiovascularRecord,
        now: Instant,
    ): MetricWriteResult {
        val inserted = cardiovascularWriteRepository.insertCardiovascular(
            sourceInstanceId,
            ingestionRecordId,
            record,
            now,
        )
        return if (inserted) {
            MetricWriteResult(created = MetricCreatedCounts(cardiovascularMeasurements = 1))
        } else {
            MetricWriteResult(duplicateSkipped = 1)
        }
    }

    private fun writeExtendedBodyMeasurement(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: ExtendedBodyMeasurementRecord,
        now: Instant,
    ): MetricWriteResult {
        val inserted = bodyMeasurementWriteRepository.insertExtendedBodyMeasurements(
            sourceInstanceId,
            ingestionRecordId,
            record,
            now,
        )
        return MetricWriteResult(
            created = MetricCreatedCounts(extendedBodyMeasurements = inserted),
            duplicateSkipped = record.measurements.size - inserted,
        )
    }
}

data class MetricWriteResult(
    val created: MetricCreatedCounts = MetricCreatedCounts(),
    val duplicateSkipped: Int = 0,
    val affectedStepSummaryDates: Set<LocalDate> = emptySet(),
    val affectedSleepNightDates: Set<LocalDate> = emptySet(),
    val affectedHeartRateCanonicalDates: Set<LocalDate> = emptySet(),
    val affectedRespiratoryRateCanonicalDates: Set<LocalDate> = emptySet(),
    val affectedHrvCanonicalDates: Set<LocalDate> = emptySet(),
    val affectedBodyMeasurementCanonicalDates: Set<LocalDate> = emptySet(),
    val affectedSleepSummaryCanonicalDates: Set<LocalDate> = emptySet(),
)

private fun affectedUtcDates(
    start: Instant,
    exclusiveEnd: Instant,
): Set<LocalDate> {
    val lastIncludedDate = exclusiveEnd.minusNanos(1).utcDate()
    val dates = linkedSetOf<LocalDate>()
    var cursor = start.utcDate()
    while (!cursor.isAfter(lastIncludedDate)) {
        dates.add(cursor)
        cursor = cursor.plusDays(1)
    }
    return dates
}

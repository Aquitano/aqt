package me.aquitano.health.application.metric.common

import me.aquitano.health.application.metric.activity.repository.ActivitySummaryWriteRepository
import me.aquitano.health.application.metric.cardiovascular.repository.CardiovascularWriteRepository
import me.aquitano.health.application.metric.scalar.ScalarSampleWriteRepository
import me.aquitano.health.application.metric.sleep.repository.SleepWriteRepository
import me.aquitano.health.application.metric.steps.repository.StepWriteRepository
import me.aquitano.health.domain.ActivitySummaryRecord
import me.aquitano.health.domain.BloodPressureRecord
import me.aquitano.health.domain.DerivedKind
import me.aquitano.health.domain.HealthRecord
import me.aquitano.health.domain.MetricCreatedCounts
import me.aquitano.health.domain.MetricKind
import me.aquitano.health.domain.ScalarMetricRegistry
import me.aquitano.health.domain.ScalarSampleRecord
import me.aquitano.health.domain.SleepSessionRecord
import me.aquitano.health.domain.SleepSummaryRecord
import me.aquitano.health.domain.StepIntervalRecord
import me.aquitano.health.shared.utcDate
import java.time.Instant
import java.time.LocalDate

class MetricWriteService(
    private val stepWriteRepository: StepWriteRepository = StepWriteRepository(),
    private val sleepWriteRepository: SleepWriteRepository = SleepWriteRepository(),
    private val activitySummaryWriteRepository: ActivitySummaryWriteRepository = ActivitySummaryWriteRepository(),
    private val cardiovascularWriteRepository: CardiovascularWriteRepository = CardiovascularWriteRepository(),
    private val scalarSampleWriteRepository: ScalarSampleWriteRepository = ScalarSampleWriteRepository(),
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

            is BloodPressureRecord -> writeBloodPressure(
                sourceInstanceId,
                ingestionRecordId,
                record,
                now,
            )

            is ScalarSampleRecord -> writeScalarSamples(
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
                created = MetricCreatedCounts.of(MetricKind.STEP_SAMPLES to 1),
                affectedDates = mapOf(
                    DerivedKind.STEP_SUMMARY to affectedUtcDates(
                        record.startAt,
                        record.endAt,
                    ),
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
                created = MetricCreatedCounts.of(
                    MetricKind.SLEEP_SESSIONS to 1,
                    MetricKind.SLEEP_STAGES to record.stages.size,
                ),
                affectedDates = mapOf(
                    DerivedKind.SLEEP_NIGHT to setOf(record.endAt.utcDate()),
                    DerivedKind.SLEEP_SESSION_CANONICAL to setOf(record.startAt.utcDate()),
                ),
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
            MetricWriteResult(
                created = MetricCreatedCounts.of(MetricKind.ACTIVITY_SUMMARIES to 1),
                affectedDates = mapOf(
                    DerivedKind.ACTIVITY_SUMMARY_CANONICAL to setOf(record.date),
                ),
            )
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
                created = MetricCreatedCounts.of(MetricKind.SLEEP_SUMMARIES to 1),
                affectedDates = mapOf(
                    DerivedKind.SLEEP_SUMMARY_CANONICAL to setOf(record.startAt.utcDate()),
                ),
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
            MetricWriteResult(created = MetricCreatedCounts.of(MetricKind.BLOOD_PRESSURE_MEASUREMENTS to 1))
        } else {
            MetricWriteResult(duplicateSkipped = 1)
        }
    }

    private fun writeScalarSamples(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: ScalarSampleRecord,
        now: Instant,
    ): MetricWriteResult {
        val insertedTypes = scalarSampleWriteRepository.insertScalarSamples(
            sourceInstanceId,
            ingestionRecordId,
            record,
            now,
        )
        val counts = insertedTypes
            .groupingBy { ScalarMetricRegistry.get(it).countsKind }
            .eachCount()
        return MetricWriteResult(
            created = MetricCreatedCounts(counts),
            duplicateSkipped = record.values.size - insertedTypes.size,
        )
    }
}

data class MetricWriteResult(
    val created: MetricCreatedCounts = MetricCreatedCounts(),
    val duplicateSkipped: Int = 0,
    val affectedDates: Map<DerivedKind, Set<LocalDate>> = emptyMap(),
)

internal fun affectedUtcDates(
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

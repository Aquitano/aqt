package me.aquitano.health.infrastructure.repositories

import me.aquitano.health.domain.BodyMeasurementRecord
import me.aquitano.health.domain.HeartRateRecord
import me.aquitano.health.domain.SleepSessionRecord
import me.aquitano.health.domain.StepIntervalRecord
import me.aquitano.health.infrastructure.database.toDbTimestamp
import me.aquitano.health.infrastructure.database.tables.*
import org.jetbrains.exposed.sql.*
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import kotlin.math.roundToInt

class MetricsWriteRepository {
    fun insertStepSample(
        provider: String,
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: StepIntervalRecord,
        now: Instant,
    ): Boolean {
        if (provider == GOOGLE_HEALTH_PROVIDER_CODE && stepSampleOverlaps(
                sourceInstanceId,
                record
            )
        ) return false
        return StepSamplesTable.insertIgnoreAndGetId {
                it[this.sourceInstanceId] = sourceInstanceId
                it[this.ingestionRecordId] = ingestionRecordId
                it[providerRecordId] = record.providerRecordId
                it[startAt] = record.startAt.toDbTimestamp()
                it[endAt] = record.endAt.toDbTimestamp()
                it[steps] = record.steps
                it[createdAt] = now.toDbTimestamp()
            } != null
    }

    fun insertSleepSession(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: SleepSessionRecord,
        now: Instant,
    ): Int? {
        val sessionId =
            SleepSessionsTable.insertIgnoreAndGetId {
                it[this.sourceInstanceId] = sourceInstanceId
                it[this.ingestionRecordId] = ingestionRecordId
                it[providerRecordId] = record.providerRecordId
                it[startAt] = record.startAt.toDbTimestamp()
                it[endAt] = record.endAt.toDbTimestamp()
                it[durationSeconds] =
                    Duration.between(record.startAt, record.endAt).seconds
                it[createdAt] = now.toDbTimestamp()
            }?.value ?: return null
        record.stages.forEach { stage ->
            SleepStagesTable.insert {
                it[sleepSessionId] = sessionId
                it[this.stage] = stage.stage
                it[startAt] = stage.startAt.toDbTimestamp()
                it[endAt] = stage.endAt.toDbTimestamp()
                it[durationSeconds] =
                    Duration.between(stage.startAt, stage.endAt).seconds
            }
        }
        return sessionId
    }

    fun insertBodyMeasurements(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: BodyMeasurementRecord,
        now: Instant,
    ): Int {
        var created = 0
        record.measurements.forEach { measurement ->
            val inserted =
                BodyMeasurementsTable.insertIgnoreAndGetId {
                    it[this.sourceInstanceId] = sourceInstanceId
                    it[this.ingestionRecordId] = ingestionRecordId
                    it[providerRecordId] = record.providerRecordId
                    it[measuredAt] = record.measuredAt.toDbTimestamp()
                    it[metricType] = measurement.metricType
                    it[value] = measurement.value
                    it[unit] = measurement.unit
                    it[createdAt] = now.toDbTimestamp()
                } != null
            if (inserted) created += 1
        }
        return created
    }

    fun insertHeartRateSample(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: HeartRateRecord,
        now: Instant,
    ): Boolean {
        return HeartRateSamplesTable.insertIgnoreAndGetId {
                it[this.sourceInstanceId] = sourceInstanceId
                it[this.ingestionRecordId] = ingestionRecordId
                it[providerRecordId] = record.providerRecordId
                it[measuredAt] = record.measuredAt.toDbTimestamp()
                it[bpm] = record.bpm
                it[context] = record.context
                it[createdAt] = now.toDbTimestamp()
            } != null
    }

    fun recomputeStepDailySummary(
        sourceInstanceId: Int,
        date: LocalDate,
        computedAt: Instant
    ) {
        val dayStart = date.atStartOfDay().toInstant(ZoneOffset.UTC)
        val dayEnd = date.plusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC)
        val rows = StepSamplesTable
            .selectAll()
            .where {
                (StepSamplesTable.sourceInstanceId eq sourceInstanceId) and
                        (StepSamplesTable.startAt less dayEnd.toDbTimestamp()) and
                        (StepSamplesTable.endAt greater dayStart.toDbTimestamp())
            }
            .toList()
        val steps = rows.sumOf {
            allocatedStepsForDay(it, dayStart, dayEnd)
        }
        val sampleCount = rows.size

        if (sampleCount == 0) {
            StepDailySummariesTable.deleteWhere {
                (StepDailySummariesTable.sourceInstanceId eq sourceInstanceId) and
                        (StepDailySummariesTable.date eq date)
            }
        } else {
            StepDailySummariesTable.upsert(
                StepDailySummariesTable.date,
                StepDailySummariesTable.sourceInstanceId,
                onUpdate = {
                    it[StepDailySummariesTable.steps] =
                        insertValue(StepDailySummariesTable.steps)
                    it[StepDailySummariesTable.sampleCount] =
                        insertValue(StepDailySummariesTable.sampleCount)
                    it[StepDailySummariesTable.computedAt] =
                        insertValue(StepDailySummariesTable.computedAt)
                },
            ) {
                it[this.sourceInstanceId] = sourceInstanceId
                it[this.date] = date
                it[this.steps] = steps
                it[this.sampleCount] = sampleCount
                it[this.computedAt] = computedAt.toDbTimestamp()
            }
        }
    }

    private fun stepSampleOverlaps(
        sourceInstanceId: Int,
        record: StepIntervalRecord,
    ): Boolean {
        val candidateStartBefore = record.endAt.plusSeconds(1).toDbTimestamp()
        val candidateEndAfter = record.startAt.minusSeconds(1).toDbTimestamp()
        return StepSamplesTable.selectAll()
            .where {
                (StepSamplesTable.sourceInstanceId eq sourceInstanceId) and
                        (StepSamplesTable.startAt less candidateStartBefore) and
                        (StepSamplesTable.endAt greater candidateEndAfter)
            }
            .any {
                val existingStart = it[StepSamplesTable.startAt].toInstant()
                val existingEnd = it[StepSamplesTable.endAt].toInstant()
                existingStart.isBefore(record.endAt) &&
                        record.startAt.isBefore(existingEnd)
            }
    }

    private fun allocatedStepsForDay(
        row: ResultRow,
        dayStart: Instant,
        dayEnd: Instant,
    ): Int {
        val sampleStart = row[StepSamplesTable.startAt].toInstant()
        val sampleEnd = row[StepSamplesTable.endAt].toInstant()
        val totalSeconds = Duration.between(sampleStart, sampleEnd).seconds
        if (totalSeconds <= 0) return 0

        val overlapStart = maxOf(sampleStart, dayStart)
        val overlapEnd = minOf(sampleEnd, dayEnd)
        val overlapSeconds = Duration.between(overlapStart, overlapEnd).seconds
        if (overlapSeconds <= 0) return 0

        val steps = row[StepSamplesTable.steps]
        return (steps.toDouble() * overlapSeconds / totalSeconds).roundToInt()
    }

}

private const val GOOGLE_HEALTH_PROVIDER_CODE = "google_health"

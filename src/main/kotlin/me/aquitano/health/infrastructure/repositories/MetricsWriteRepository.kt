package me.aquitano.health.infrastructure.repositories

import me.aquitano.health.domain.BodyMeasurementRecord
import me.aquitano.health.domain.HeartRateRecord
import me.aquitano.health.domain.SleepSessionRecord
import me.aquitano.health.domain.StepIntervalRecord
import me.aquitano.health.infrastructure.database.tables.*
import org.jetbrains.exposed.sql.*
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.SqlExpressionBuilder.greater
import org.jetbrains.exposed.sql.SqlExpressionBuilder.less
import java.time.Duration
import java.time.Instant
import java.time.LocalDate

class MetricsWriteRepository {
    fun insertStepSample(
        provider: String,
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: StepIntervalRecord,
        now: Instant,
    ): Boolean {
        if (record.providerRecordId != null && stepSampleExists(
                sourceInstanceId,
                record.providerRecordId
            )
        ) return false
        if (provider == GOOGLE_HEALTH_PROVIDER_CODE && stepSampleOverlaps(
                sourceInstanceId,
                record
            )
        ) return false
        StepSamplesTable.insert {
            it[this.sourceInstanceId] = sourceInstanceId
            it[this.ingestionRecordId] = ingestionRecordId
            it[providerRecordId] = record.providerRecordId
            it[startAt] = record.startAt.toString()
            it[endAt] = record.endAt.toString()
            it[steps] = record.steps
            it[createdAt] = now.toString()
        }
        return true
    }

    fun insertSleepSession(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: SleepSessionRecord,
        now: Instant,
    ): Int? {
        if (record.providerRecordId != null && sleepSessionExists(
                sourceInstanceId,
                record.providerRecordId
            )
        ) return null
        val sessionId = SleepSessionsTable.insertAndGetId {
            it[this.sourceInstanceId] = sourceInstanceId
            it[this.ingestionRecordId] = ingestionRecordId
            it[providerRecordId] = record.providerRecordId
            it[startAt] = record.startAt.toString()
            it[endAt] = record.endAt.toString()
            it[durationSeconds] =
                Duration.between(record.startAt, record.endAt).seconds
            it[createdAt] = now.toString()
        }.value
        record.stages.forEach { stage ->
            SleepStagesTable.insert {
                it[sleepSessionId] = sessionId
                it[this.stage] = stage.stage
                it[startAt] = stage.startAt.toString()
                it[endAt] = stage.endAt.toString()
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
            if (
                record.providerRecordId != null &&
                bodyMeasurementExists(
                    sourceInstanceId,
                    record.providerRecordId,
                    measurement.metricType
                )
            ) {
                return@forEach
            }
            BodyMeasurementsTable.insert {
                it[this.sourceInstanceId] = sourceInstanceId
                it[this.ingestionRecordId] = ingestionRecordId
                it[providerRecordId] = record.providerRecordId
                it[measuredAt] = record.measuredAt.toString()
                it[metricType] = measurement.metricType
                it[value] = measurement.value
                it[unit] = measurement.unit
                it[createdAt] = now.toString()
            }
            created += 1
        }
        return created
    }

    fun insertHeartRateSample(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: HeartRateRecord,
        now: Instant,
    ): Boolean {
        if (record.providerRecordId != null && heartRateSampleExists(
                sourceInstanceId,
                record.providerRecordId
            )
        ) return false
        HeartRateSamplesTable.insert {
            it[this.sourceInstanceId] = sourceInstanceId
            it[this.ingestionRecordId] = ingestionRecordId
            it[providerRecordId] = record.providerRecordId
            it[measuredAt] = record.measuredAt.toString()
            it[bpm] = record.bpm
            it[context] = record.context
            it[createdAt] = now.toString()
        }
        return true
    }

    fun recomputeStepDailySummary(
        sourceInstanceId: Int,
        date: LocalDate,
        computedAt: Instant
    ) {
        val rows = StepSamplesTable
            .selectAll()
            .where {
                (StepSamplesTable.sourceInstanceId eq sourceInstanceId) and
                        (StepSamplesTable.startAt like "${date}%")
            }
            .toList()
        val steps = rows.sumOf { it[StepSamplesTable.steps] }
        val sampleCount = rows.size

        StepDailySummariesTable.deleteWhere {
            (StepDailySummariesTable.sourceInstanceId eq sourceInstanceId) and
                    (StepDailySummariesTable.date eq date.toString())
        }
        if (sampleCount > 0) {
            StepDailySummariesTable.insert {
                it[this.sourceInstanceId] = sourceInstanceId
                it[this.date] = date.toString()
                it[this.steps] = steps
                it[this.sampleCount] = sampleCount
                it[this.computedAt] = computedAt.toString()
            }
        }
    }

    private fun stepSampleExists(
        sourceInstanceId: Int,
        providerRecordId: String
    ): Boolean =
        StepSamplesTable.selectAll()
            .where {
                (StepSamplesTable.sourceInstanceId eq sourceInstanceId) and
                        (StepSamplesTable.providerRecordId eq providerRecordId)
            }
            .limit(1)
            .any()

    private fun stepSampleOverlaps(
        sourceInstanceId: Int,
        record: StepIntervalRecord,
    ): Boolean {
        val candidateStartBefore = record.endAt.plusSeconds(1).toString()
        val candidateEndAfter = record.startAt.minusSeconds(1).toString()
        return StepSamplesTable.selectAll()
            .where {
                (StepSamplesTable.sourceInstanceId eq sourceInstanceId) and
                        (StepSamplesTable.startAt less candidateStartBefore) and
                        (StepSamplesTable.endAt greater candidateEndAfter)
            }
            .any {
                val existingStart = runCatching {
                    Instant.parse(it[StepSamplesTable.startAt])
                }.getOrNull()
                val existingEnd = runCatching {
                    Instant.parse(it[StepSamplesTable.endAt])
                }.getOrNull()
                existingStart != null &&
                        existingEnd != null &&
                        existingStart.isBefore(record.endAt) &&
                        record.startAt.isBefore(existingEnd)
            }
    }

    private fun sleepSessionExists(
        sourceInstanceId: Int,
        providerRecordId: String
    ): Boolean =
        SleepSessionsTable.selectAll()
            .where {
                (SleepSessionsTable.sourceInstanceId eq sourceInstanceId) and
                        (SleepSessionsTable.providerRecordId eq providerRecordId)
            }
            .limit(1)
            .any()

    private fun bodyMeasurementExists(
        sourceInstanceId: Int,
        providerRecordId: String,
        metricType: String
    ): Boolean =
        BodyMeasurementsTable.selectAll()
            .where {
                (BodyMeasurementsTable.sourceInstanceId eq sourceInstanceId) and
                        (BodyMeasurementsTable.providerRecordId eq providerRecordId) and
                        (BodyMeasurementsTable.metricType eq metricType)
            }
            .limit(1)
            .any()

    private fun heartRateSampleExists(
        sourceInstanceId: Int,
        providerRecordId: String
    ): Boolean =
        HeartRateSamplesTable.selectAll()
            .where {
                (HeartRateSamplesTable.sourceInstanceId eq sourceInstanceId) and
                        (HeartRateSamplesTable.providerRecordId eq providerRecordId)
            }
            .limit(1)
            .any()
}

private const val GOOGLE_HEALTH_PROVIDER_CODE = "google_health"

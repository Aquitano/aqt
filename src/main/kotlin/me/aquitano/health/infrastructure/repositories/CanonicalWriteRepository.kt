package me.aquitano.health.infrastructure.repositories

import me.aquitano.health.domain.BodyMeasurementRecord
import me.aquitano.health.domain.HeartRateRecord
import me.aquitano.health.domain.SleepSessionRecord
import me.aquitano.health.domain.StepIntervalRecord
import me.aquitano.health.infrastructure.database.tables.BodyMeasurementsTable
import me.aquitano.health.infrastructure.database.tables.HeartRateSamplesTable
import me.aquitano.health.infrastructure.database.tables.SleepSessionsTable
import me.aquitano.health.infrastructure.database.tables.SleepStagesTable
import me.aquitano.health.infrastructure.database.tables.StepDailySummariesTable
import me.aquitano.health.infrastructure.database.tables.StepSamplesTable
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.deleteWhere
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.insertAndGetId
import org.jetbrains.exposed.sql.selectAll
import java.time.Duration
import java.time.Instant
import java.time.LocalDate

class CanonicalWriteRepository {
    fun insertStepSample(
        sourceInstanceId: Int,
        rawRecordId: Int,
        record: StepIntervalRecord,
        now: Instant,
    ): Boolean {
        if (record.providerRecordId != null && stepSampleExists(sourceInstanceId, record.providerRecordId)) return false
        StepSamplesTable.insert {
            it[this.sourceInstanceId] = sourceInstanceId
            it[this.rawRecordId] = rawRecordId
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
        rawRecordId: Int,
        record: SleepSessionRecord,
        now: Instant,
    ): Int? {
        if (record.providerRecordId != null && sleepSessionExists(sourceInstanceId, record.providerRecordId)) return null
        val sessionId = SleepSessionsTable.insertAndGetId {
            it[this.sourceInstanceId] = sourceInstanceId
            it[this.rawRecordId] = rawRecordId
            it[providerRecordId] = record.providerRecordId
            it[startAt] = record.startAt.toString()
            it[endAt] = record.endAt.toString()
            it[durationSeconds] = Duration.between(record.startAt, record.endAt).seconds
            it[createdAt] = now.toString()
        }.value
        record.stages.forEach { stage ->
            SleepStagesTable.insert {
                it[sleepSessionId] = sessionId
                it[this.stage] = stage.stage
                it[startAt] = stage.startAt.toString()
                it[endAt] = stage.endAt.toString()
                it[durationSeconds] = Duration.between(stage.startAt, stage.endAt).seconds
            }
        }
        return sessionId
    }

    fun insertBodyMeasurements(
        sourceInstanceId: Int,
        rawRecordId: Int,
        record: BodyMeasurementRecord,
        now: Instant,
    ): Int {
        var created = 0
        record.measurements.forEach { measurement ->
            if (
                record.providerRecordId != null &&
                bodyMeasurementExists(sourceInstanceId, record.providerRecordId, measurement.metricType)
            ) {
                return@forEach
            }
            BodyMeasurementsTable.insert {
                it[this.sourceInstanceId] = sourceInstanceId
                it[this.rawRecordId] = rawRecordId
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
        rawRecordId: Int,
        record: HeartRateRecord,
        now: Instant,
    ): Boolean {
        if (record.providerRecordId != null && heartRateSampleExists(sourceInstanceId, record.providerRecordId)) return false
        HeartRateSamplesTable.insert {
            it[this.sourceInstanceId] = sourceInstanceId
            it[this.rawRecordId] = rawRecordId
            it[providerRecordId] = record.providerRecordId
            it[measuredAt] = record.measuredAt.toString()
            it[bpm] = record.bpm
            it[context] = record.context
            it[createdAt] = now.toString()
        }
        return true
    }

    fun recomputeStepDailySummary(sourceInstanceId: Int, date: LocalDate, computedAt: Instant) {
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

    private fun stepSampleExists(sourceInstanceId: Int, providerRecordId: String): Boolean =
        StepSamplesTable.selectAll()
            .where {
                (StepSamplesTable.sourceInstanceId eq sourceInstanceId) and
                    (StepSamplesTable.providerRecordId eq providerRecordId)
            }
            .limit(1)
            .any()

    private fun sleepSessionExists(sourceInstanceId: Int, providerRecordId: String): Boolean =
        SleepSessionsTable.selectAll()
            .where {
                (SleepSessionsTable.sourceInstanceId eq sourceInstanceId) and
                    (SleepSessionsTable.providerRecordId eq providerRecordId)
            }
            .limit(1)
            .any()

    private fun bodyMeasurementExists(sourceInstanceId: Int, providerRecordId: String, metricType: String): Boolean =
        BodyMeasurementsTable.selectAll()
            .where {
                (BodyMeasurementsTable.sourceInstanceId eq sourceInstanceId) and
                    (BodyMeasurementsTable.providerRecordId eq providerRecordId) and
                    (BodyMeasurementsTable.metricType eq metricType)
            }
            .limit(1)
            .any()

    private fun heartRateSampleExists(sourceInstanceId: Int, providerRecordId: String): Boolean =
        HeartRateSamplesTable.selectAll()
            .where {
                (HeartRateSamplesTable.sourceInstanceId eq sourceInstanceId) and
                    (HeartRateSamplesTable.providerRecordId eq providerRecordId)
            }
            .limit(1)
            .any()
}

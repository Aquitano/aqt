package me.aquitano.health.infrastructure.repositories

import me.aquitano.health.domain.BodyMeasurementRecord
import me.aquitano.health.domain.HeartRateRecord
import me.aquitano.health.domain.SleepSessionRecord
import me.aquitano.health.domain.StepIntervalRecord
import me.aquitano.health.infrastructure.database.tables.*
import org.jetbrains.exposed.exceptions.ExposedSQLException
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
        if (provider == GOOGLE_HEALTH_PROVIDER_CODE && stepSampleOverlaps(
                sourceInstanceId,
                record
            )
        ) return false
        return insertOrSkipDuplicateUnit {
            StepSamplesTable.insert {
                it[this.sourceInstanceId] = sourceInstanceId
                it[this.ingestionRecordId] = ingestionRecordId
                it[providerRecordId] = record.providerRecordId
                it[startAt] = record.startAt.toString()
                it[endAt] = record.endAt.toString()
                it[steps] = record.steps
                it[createdAt] = now.toString()
            }
            Unit
        }
    }

    fun insertSleepSession(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: SleepSessionRecord,
        now: Instant,
    ): Int? {
        val sessionId = insertOrNullOnDuplicate {
            SleepSessionsTable.insertAndGetId {
                it[this.sourceInstanceId] = sourceInstanceId
                it[this.ingestionRecordId] = ingestionRecordId
                it[providerRecordId] = record.providerRecordId
                it[startAt] = record.startAt.toString()
                it[endAt] = record.endAt.toString()
                it[durationSeconds] =
                    Duration.between(record.startAt, record.endAt).seconds
                it[createdAt] = now.toString()
            }.value
        } ?: return null
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
            val inserted = insertOrSkipDuplicateUnit {
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
                Unit
            }
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
        return insertOrSkipDuplicateUnit {
            HeartRateSamplesTable.insert {
                it[this.sourceInstanceId] = sourceInstanceId
                it[this.ingestionRecordId] = ingestionRecordId
                it[providerRecordId] = record.providerRecordId
                it[measuredAt] = record.measuredAt.toString()
                it[bpm] = record.bpm
                it[context] = record.context
                it[createdAt] = now.toString()
            }
            Unit
        }
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

    private fun insertOrSkipDuplicateUnit(block: () -> Unit): Boolean =
        try {
            block()
            true
        } catch (exception: ExposedSQLException) {
            if (exception.isUniqueConstraintViolation()) false else throw exception
        }

    private fun <T : Any> insertOrNullOnDuplicate(block: () -> T): T? =
        try {
            block()
        } catch (exception: ExposedSQLException) {
            if (exception.isUniqueConstraintViolation()) null else throw exception
        }
}

private const val GOOGLE_HEALTH_PROVIDER_CODE = "google_health"

private fun ExposedSQLException.isUniqueConstraintViolation(): Boolean {
    val text = listOfNotNull(message, cause?.message).joinToString("\n")
    return text.contains("UNIQUE constraint failed", ignoreCase = true) ||
            text.contains("SQLITE_CONSTRAINT_UNIQUE", ignoreCase = true)
}

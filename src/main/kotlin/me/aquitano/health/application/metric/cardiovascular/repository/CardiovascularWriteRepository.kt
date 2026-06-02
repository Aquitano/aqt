package me.aquitano.health.application.metric.cardiovascular.repository

import me.aquitano.health.domain.BloodPressureRecord
import me.aquitano.health.domain.CardiovascularRecord
import me.aquitano.health.infrastructure.database.tables.BloodPressureMeasurementsTable
import me.aquitano.health.infrastructure.database.tables.CardiovascularMeasurementsTable
import me.aquitano.health.infrastructure.database.toDbTimestamp
import org.jetbrains.exposed.v1.jdbc.insertIgnoreAndGetId
import java.time.Instant

class CardiovascularWriteRepository {
    fun insertBloodPressure(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: BloodPressureRecord,
        now: Instant,
    ): Boolean =
        BloodPressureMeasurementsTable.insertIgnoreAndGetId {
            it[this.sourceInstanceId] = sourceInstanceId
            it[this.ingestionRecordId] = ingestionRecordId
            it[providerRecordId] = record.providerRecordId
            it[measuredAt] = record.measuredAt.toDbTimestamp()
            it[systolicMmhg] = record.systolicMmhg
            it[diastolicMmhg] = record.diastolicMmhg
            it[heartRateBpm] = record.heartRateBpm
            it[createdAt] = now.toDbTimestamp()
        } != null

    fun insertCardiovascular(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: CardiovascularRecord,
        now: Instant,
    ): Boolean =
        CardiovascularMeasurementsTable.insertIgnoreAndGetId {
            it[this.sourceInstanceId] = sourceInstanceId
            it[this.ingestionRecordId] = ingestionRecordId
            it[providerRecordId] = record.providerRecordId
            it[measuredAt] = record.measuredAt.toDbTimestamp()
            it[metricType] = record.metricType
            it[value] = record.value
            it[unit] = record.unit
            it[createdAt] = now.toDbTimestamp()
        } != null
}

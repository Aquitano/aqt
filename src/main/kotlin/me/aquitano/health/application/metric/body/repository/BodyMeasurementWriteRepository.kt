package me.aquitano.health.application.metric.body.repository

import me.aquitano.health.domain.BodyMeasurementRecord
import me.aquitano.health.domain.ExtendedBodyMeasurementRecord
import me.aquitano.health.infrastructure.database.tables.BodyMeasurementsTable
import me.aquitano.health.infrastructure.database.tables.ExtendedBodyMeasurementsTable
import me.aquitano.health.infrastructure.database.toDbTimestamp
import org.jetbrains.exposed.v1.jdbc.insertIgnoreAndGetId
import java.time.Instant

class BodyMeasurementWriteRepository {
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

    fun insertExtendedBodyMeasurements(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: ExtendedBodyMeasurementRecord,
        now: Instant,
    ): Int {
        var created = 0
        record.measurements.forEach { measurement ->
            val inserted =
                ExtendedBodyMeasurementsTable.insertIgnoreAndGetId {
                    it[this.sourceInstanceId] = sourceInstanceId
                    it[this.ingestionRecordId] = ingestionRecordId
                    it[providerRecordId] = record.providerRecordId
                    it[measuredAt] = record.measuredAt.toDbTimestamp()
                    it[metricType] = measurement.metricType
                    it[value] = measurement.value
                    it[unit] = measurement.unit
                    it[segment] = measurement.segment
                    it[createdAt] = now.toDbTimestamp()
                } != null
            if (inserted) created += 1
        }
        return created
    }
}

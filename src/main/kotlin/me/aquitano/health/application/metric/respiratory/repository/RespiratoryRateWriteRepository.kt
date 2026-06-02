package me.aquitano.health.application.metric.respiratory.repository

import me.aquitano.health.domain.RespiratoryRateRecord
import me.aquitano.health.infrastructure.database.tables.RespiratoryRateSamplesTable
import me.aquitano.health.infrastructure.database.toDbTimestamp
import org.jetbrains.exposed.v1.jdbc.insertIgnoreAndGetId
import java.time.Instant

class RespiratoryRateWriteRepository {
    fun insertRespiratoryRateSample(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: RespiratoryRateRecord,
        now: Instant,
    ): Boolean =
        RespiratoryRateSamplesTable.insertIgnoreAndGetId {
            it[this.sourceInstanceId] = sourceInstanceId
            it[this.ingestionRecordId] = ingestionRecordId
            it[providerRecordId] = record.providerRecordId
            it[measuredAt] = record.measuredAt.toDbTimestamp()
            it[breathsPerMinute] = record.breathsPerMinute
            it[context] = record.context
            it[createdAt] = now.toDbTimestamp()
        } != null
}

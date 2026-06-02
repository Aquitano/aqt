package me.aquitano.health.application.metric.hrv.repository

import me.aquitano.health.domain.HrvRecord
import me.aquitano.health.infrastructure.database.tables.HrvSamplesTable
import me.aquitano.health.infrastructure.database.toDbTimestamp
import org.jetbrains.exposed.v1.jdbc.insertIgnoreAndGetId
import java.time.Instant

class HrvWriteRepository {
    fun insertHrvSample(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: HrvRecord,
        now: Instant,
    ): Boolean =
        HrvSamplesTable.insertIgnoreAndGetId {
            it[this.sourceInstanceId] = sourceInstanceId
            it[this.ingestionRecordId] = ingestionRecordId
            it[providerRecordId] = record.providerRecordId
            it[measuredAt] = record.measuredAt.toDbTimestamp()
            it[metricType] = record.metricType
            it[value] = record.value
            it[unit] = record.unit
            it[context] = record.context
            it[createdAt] = now.toDbTimestamp()
        } != null
}

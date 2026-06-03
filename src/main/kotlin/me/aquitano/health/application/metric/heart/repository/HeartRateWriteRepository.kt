package me.aquitano.health.application.metric.heart.repository

import me.aquitano.health.domain.HeartRateRecord
import me.aquitano.health.infrastructure.database.tables.HeartRateSamplesTable
import me.aquitano.health.infrastructure.database.toDbTimestamp
import org.jetbrains.exposed.v1.jdbc.insertIgnoreAndGetId
import java.time.Instant

class HeartRateWriteRepository {
    fun insertHeartRateSample(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: HeartRateRecord,
        now: Instant,
    ): Boolean =
        HeartRateSamplesTable.insertIgnoreAndGetId {
            it[this.sourceInstanceId] = sourceInstanceId
            it[this.ingestionRecordId] = ingestionRecordId
            it[providerRecordId] = record.providerRecordId
            it[measuredAt] = record.measuredAt.toDbTimestamp()
            it[bpm] = record.bpm
            it[context] = record.context
            it[createdAt] = now.toDbTimestamp()
        } != null
}

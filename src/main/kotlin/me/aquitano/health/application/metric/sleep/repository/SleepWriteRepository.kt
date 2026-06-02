package me.aquitano.health.application.metric.sleep.repository

import me.aquitano.health.domain.SleepSessionRecord
import me.aquitano.health.infrastructure.database.tables.SleepSessionsTable
import me.aquitano.health.infrastructure.database.tables.SleepStagesTable
import me.aquitano.health.infrastructure.database.toDbTimestamp
import org.jetbrains.exposed.v1.jdbc.insert
import org.jetbrains.exposed.v1.jdbc.insertIgnoreAndGetId
import java.time.Duration
import java.time.Instant

class SleepWriteRepository {
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
}

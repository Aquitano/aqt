package me.aquitano.health.application.metric.sleep.repository

import me.aquitano.health.domain.SleepSessionRecord
import me.aquitano.health.domain.SleepSummaryRecord
import me.aquitano.health.infrastructure.database.tables.SleepSessionsTable
import me.aquitano.health.infrastructure.database.tables.SleepStagesTable
import me.aquitano.health.infrastructure.database.tables.SleepSummariesTable
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

    fun insertSleepSummary(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: SleepSummaryRecord,
        now: Instant,
    ): Boolean =
        SleepSummariesTable.insertIgnoreAndGetId {
            it[this.sourceInstanceId] = sourceInstanceId
            it[this.ingestionRecordId] = ingestionRecordId
            it[providerRecordId] = record.providerRecordId
            it[startAt] = record.startAt.toDbTimestamp()
            it[endAt] = record.endAt.toDbTimestamp()
            it[timeInBedSeconds] = record.timeInBedSeconds
            it[totalSleepSeconds] = record.totalSleepSeconds
            it[lightSleepSeconds] = record.lightSleepSeconds
            it[deepSleepSeconds] = record.deepSleepSeconds
            it[remSleepSeconds] = record.remSleepSeconds
            it[sleepEfficiencyPercent] = record.sleepEfficiencyPercent
            it[sleepLatencySeconds] = record.sleepLatencySeconds
            it[wakeupLatencySeconds] = record.wakeupLatencySeconds
            it[wakeupDurationSeconds] = record.wakeupDurationSeconds
            it[wakeupCount] = record.wakeupCount
            it[wasoSeconds] = record.wasoSeconds
            it[sleepScore] = record.sleepScore
            it[remEpisodesCount] = record.remEpisodesCount
            it[outOfBedCount] = record.outOfBedCount
            it[awakeDurationSeconds] = record.awakeDurationSeconds
            it[overnightHrvRmssd] = record.overnightHrvRmssd
            it[respiratoryRhythm] = record.respiratoryRhythm
            it[breathingQuality] = record.breathingQuality
            it[snoringDurationSeconds] = record.snoringDurationSeconds
            it[apneaHypopneaIndex] = record.apneaHypopneaIndex
            it[movementScore] = record.movementScore
            it[snoringEpisodeCount] = record.snoringEpisodeCount
            it[hrAverageBpm] = record.hrAverageBpm
            it[hrMinBpm] = record.hrMinBpm
            it[hrMaxBpm] = record.hrMaxBpm
            it[rrAverage] = record.rrAverage
            it[rrMin] = record.rrMin
            it[rrMax] = record.rrMax
            it[createdAt] = now.toDbTimestamp()
        } != null
}

package me.aquitano.health.application.metric.activity.repository

import me.aquitano.health.domain.ActivitySummaryRecord
import me.aquitano.health.infrastructure.database.tables.ActivitySummariesTable
import me.aquitano.health.infrastructure.database.toDbTimestamp
import org.jetbrains.exposed.v1.jdbc.insertIgnoreAndGetId
import java.time.Instant

class ActivitySummaryWriteRepository {
    fun insertActivitySummary(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: ActivitySummaryRecord,
        now: Instant,
    ): Boolean =
        ActivitySummariesTable.insertIgnoreAndGetId {
            it[this.sourceInstanceId] = sourceInstanceId
            it[this.ingestionRecordId] = ingestionRecordId
            it[providerRecordId] = record.providerRecordId
            it[date] = record.date
            it[distanceMeters] = record.distanceMeters
            it[activeEnergyKcal] = record.activeEnergyKcal
            it[totalEnergyKcal] = record.totalEnergyKcal
            it[elevationMeters] = record.elevationMeters
            it[softMinutes] = record.softMinutes
            it[moderateMinutes] = record.moderateMinutes
            it[intenseMinutes] = record.intenseMinutes
            it[activeMinutes] = record.activeMinutes
            it[avgHeartRateBpm] = record.averageHeartRateBpm
            it[minHeartRateBpm] = record.minHeartRateBpm
            it[maxHeartRateBpm] = record.maxHeartRateBpm
            it[createdAt] = now.toDbTimestamp()
        } != null
}

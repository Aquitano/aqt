package me.aquitano.health.application.metric.activity.repository

import me.aquitano.health.application.metric.common.repository.*
import me.aquitano.health.infrastructure.database.tables.*
import me.aquitano.health.infrastructure.database.toApiString
import me.aquitano.health.infrastructure.database.toDbTimestamp
import me.aquitano.health.infrastructure.repositories.common.BaseMetricRepository
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.greater
import org.jetbrains.exposed.v1.core.greaterEq
import org.jetbrains.exposed.v1.core.inList
import org.jetbrains.exposed.v1.core.less
import org.jetbrains.exposed.v1.core.lessEq
import org.jetbrains.exposed.v1.jdbc.*
import java.time.Instant

class ActivitySummaryRepository : BaseMetricRepository() {
    fun listActivitySummaries(filters: DailyReadFilters): Pair<List<ActivitySummaryRow>, Map<Int, SourceMetadata>> {
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return emptyList<ActivitySummaryRow>() to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.fromDate?.let { conditions.add(ActivitySummariesTable.date greaterEq it) }
        filters.toDate?.let { conditions.add(ActivitySummariesTable.date lessEq it) }
        sourceIds?.let { conditions.add(ActivitySummariesTable.sourceInstanceId inList it) }
        val rows = ActivitySummariesTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                ActivitySummariesTable.date to filters.sortOrder(),
                ActivitySummariesTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map(::toActivitySummaryRow)
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
    }

    fun latestActivitySummary(filters: DailyReadFilters): Pair<ActivitySummaryRow?, Map<Int, SourceMetadata>> {
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return null to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.fromDate?.let { conditions.add(ActivitySummariesTable.date greaterEq it) }
        filters.toDate?.let { conditions.add(ActivitySummariesTable.date lessEq it) }
        sourceIds?.let { conditions.add(ActivitySummariesTable.sourceInstanceId inList it) }
        val row = ActivitySummariesTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                ActivitySummariesTable.date to SortOrder.DESC,
                ActivitySummariesTable.id to SortOrder.DESC,
            )
            .limit(1)
            .map(::toActivitySummaryRow)
            .singleOrNull()
        return row to sourceMetadata(listOfNotNull(row?.sourceInstanceId).toSet(), filters.includeSource)
    }

    private fun toActivitySummaryRow(row: ResultRow): ActivitySummaryRow =
        ActivitySummaryRow(
            id = row[ActivitySummariesTable.id].value,
            sourceInstanceId = row[ActivitySummariesTable.sourceInstanceId],
            date = row[ActivitySummariesTable.date].toString(),
            distanceMeters = row[ActivitySummariesTable.distanceMeters],
            activeEnergyKcal = row[ActivitySummariesTable.activeEnergyKcal],
            totalEnergyKcal = row[ActivitySummariesTable.totalEnergyKcal],
            elevationMeters = row[ActivitySummariesTable.elevationMeters],
            softMinutes = row[ActivitySummariesTable.softMinutes],
            moderateMinutes = row[ActivitySummariesTable.moderateMinutes],
            intenseMinutes = row[ActivitySummariesTable.intenseMinutes],
            activeMinutes = row[ActivitySummariesTable.activeMinutes],
            averageHeartRateBpm = row[ActivitySummariesTable.avgHeartRateBpm],
            minHeartRateBpm = row[ActivitySummariesTable.minHeartRateBpm],
            maxHeartRateBpm = row[ActivitySummariesTable.maxHeartRateBpm],
        )


}

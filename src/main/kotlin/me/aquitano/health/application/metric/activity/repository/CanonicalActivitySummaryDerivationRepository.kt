package me.aquitano.health.application.metric.activity.repository

import me.aquitano.health.application.metric.common.keysetFetchLimit
import me.aquitano.health.application.metric.common.repository.DailyReadFilters
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.infrastructure.database.tables.ActivitySummariesTable
import me.aquitano.health.infrastructure.database.tables.CanonicalActivitySummariesTable
import me.aquitano.health.infrastructure.repositories.common.BaseMetricRepository
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.jdbc.selectAll

/** Reads through the canonical_activity_summaries view (rank winner per date, see V15). */
class CanonicalActivitySummaryDerivationRepository : BaseMetricRepository() {
    fun listCanonicalActivitySummaries(
        filters: DailyReadFilters,
    ): Pair<List<ActivitySummaryRow>, Map<Int, SourceMetadata>> {
        val where = dateConditions(
            filters = filters,
            sourceInstanceIdColumn = CanonicalActivitySummariesTable.sourceInstanceId,
            dateColumn = CanonicalActivitySummariesTable.date,
        ).whereOrNull() ?: return emptyReadResult()

        val keyset = dateKeyset(
            filters.cursor,
            filters.order,
            ActivitySummariesTable.date,
            ActivitySummariesTable.id,
        )
        val rows = CanonicalActivitySummariesTable
            .innerJoin(ActivitySummariesTable, { activitySummaryId }, { ActivitySummariesTable.id })
            .selectAll()
            .where(keyset?.let { where and it } ?: where)
            .orderBy(
                ActivitySummariesTable.date to filters.sortOrder(),
                ActivitySummariesTable.id to filters.sortOrder(),
            )
            .limit(keysetFetchLimit(filters.limit))
            .map(::toActivitySummaryRow)
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
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

package me.aquitano.health.application.metric.activity.repository

import me.aquitano.health.application.metric.common.repository.DailyReadFilters
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.infrastructure.database.tables.ActivitySummariesTable
import me.aquitano.health.infrastructure.database.tables.CanonicalActivitySummariesTable
import me.aquitano.health.infrastructure.database.toDbTimestamp
import me.aquitano.health.infrastructure.repositories.common.BaseMetricRepository
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.jdbc.deleteWhere
import org.jetbrains.exposed.v1.jdbc.insert
import org.jetbrains.exposed.v1.jdbc.selectAll
import java.time.Instant
import java.time.LocalDate

data class CanonicalActivitySummaryOutput(
    val activitySummaryId: Int,
    val sourceInstanceId: Int,
    val date: LocalDate,
)

data class CanonicalActivityOutput(
    val date: LocalDate,
    val algorithmVersion: Int,
    val computedAt: Instant,
    val summary: CanonicalActivitySummaryOutput?,
)

class CanonicalActivitySummaryDerivationRepository : BaseMetricRepository() {
    fun listRawSummariesForDay(date: LocalDate): List<ActivitySummaryRow> =
        ActivitySummariesTable.selectAll()
            .where { ActivitySummariesTable.date eq date }
            .orderBy(ActivitySummariesTable.id to SortOrder.ASC)
            .map(::toActivitySummaryRow)

    fun persistCanonicalOutput(output: CanonicalActivityOutput): Int {
        CanonicalActivitySummariesTable.deleteWhere {
            (CanonicalActivitySummariesTable.date eq output.date) and
                (CanonicalActivitySummariesTable.algorithmVersion eq output.algorithmVersion)
        }
        val summary = output.summary ?: return 0
        CanonicalActivitySummariesTable.insert {
            it[date] = summary.date
            it[sourceInstanceId] = summary.sourceInstanceId
            it[activitySummaryId] = summary.activitySummaryId
            it[algorithmVersion] = output.algorithmVersion
            it[computedAt] = output.computedAt.toDbTimestamp()
        }
        return 1
    }

    fun listCanonicalActivitySummaries(
        filters: DailyReadFilters,
        algorithmVersion: Int,
    ): Pair<List<ActivitySummaryRow>, Map<Int, SourceMetadata>> {
        val where = dateConditions(
            filters = filters,
            sourceInstanceIdColumn = CanonicalActivitySummariesTable.sourceInstanceId,
            dateColumn = CanonicalActivitySummariesTable.date,
        ).whereOrNull() ?: return emptyReadResult()

        val rows = CanonicalActivitySummariesTable
            .innerJoin(ActivitySummariesTable, { activitySummaryId }, { ActivitySummariesTable.id })
            .selectAll()
            .where { where and (CanonicalActivitySummariesTable.algorithmVersion eq algorithmVersion) }
            .orderBy(
                ActivitySummariesTable.date to filters.sortOrder(),
                ActivitySummariesTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
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

package me.aquitano.health.application.metric.respiratory.repository

import me.aquitano.health.application.metric.common.repository.*
import me.aquitano.health.infrastructure.database.tables.*
import me.aquitano.health.infrastructure.repositories.common.BaseMetricRepository
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.jdbc.*

class RespiratoryRateRepository : BaseMetricRepository() {
    fun listRespiratoryRateSamples(filters: ReadFilters): Pair<List<RespiratoryRateSampleRow>, Map<Int, SourceMetadata>> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = RespiratoryRateSamplesTable.sourceInstanceId,
            fromColumn = RespiratoryRateSamplesTable.measuredAt,
        ).whereOrNull() ?: return emptyReadResult()

        val rows = RespiratoryRateSamplesTable.selectAll()
            .where(where)
            .orderBy(
                RespiratoryRateSamplesTable.measuredAt to filters.sortOrder(),
                RespiratoryRateSamplesTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map(::toRespiratoryRateSampleRow)
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
    }

    fun latestRespiratoryRateSample(filters: ReadFilters): Pair<RespiratoryRateSampleRow?, Map<Int, SourceMetadata>> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = RespiratoryRateSamplesTable.sourceInstanceId,
            fromColumn = RespiratoryRateSamplesTable.measuredAt,
        ).whereOrNull() ?: return emptyLatestResult()

        val row = RespiratoryRateSamplesTable.selectAll()
            .where(where)
            .orderBy(
                RespiratoryRateSamplesTable.measuredAt to SortOrder.DESC,
                RespiratoryRateSamplesTable.id to SortOrder.DESC,
            )
            .limit(1)
            .map(::toRespiratoryRateSampleRow)
            .singleOrNull()
        return row to sourceMetadata(listOfNotNull(row?.sourceInstanceId).toSet(), filters.includeSource)
    }

    fun summarizeRespiratoryRate(filters: ReadFilters): RespiratoryRateSummaryRow {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = RespiratoryRateSamplesTable.sourceInstanceId,
            fromColumn = RespiratoryRateSamplesTable.measuredAt,
        ).whereOrNull() ?: return RespiratoryRateSummaryRow(0, null, null, null)

        val countExpression = RespiratoryRateSamplesTable.id.count()
        val minExpression = RespiratoryRateSamplesTable.breathsPerMinute.min()
        val maxExpression = RespiratoryRateSamplesTable.breathsPerMinute.max()
        val avgExpression = RespiratoryRateSamplesTable.breathsPerMinute.avg()
        return RespiratoryRateSamplesTable
            .select(countExpression, minExpression, maxExpression, avgExpression)
            .where(where)
            .single()
            .let {
                RespiratoryRateSummaryRow(
                    count = it[countExpression].toInt(),
                    minBreathsPerMinute = it[minExpression],
                    maxBreathsPerMinute = it[maxExpression],
                    avgBreathsPerMinute = it[avgExpression]?.toDouble(),
                )
            }
    }

    private fun toRespiratoryRateSampleRow(row: ResultRow): RespiratoryRateSampleRow =
        RespiratoryRateSampleRow(
            id = row[RespiratoryRateSamplesTable.id].value,
            sourceInstanceId = row[RespiratoryRateSamplesTable.sourceInstanceId],
            measuredAt = row[RespiratoryRateSamplesTable.measuredAt].toInstant(),
            breathsPerMinute = row[RespiratoryRateSamplesTable.breathsPerMinute],
            context = row[RespiratoryRateSamplesTable.context] ?: "unknown",
        )

}

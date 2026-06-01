package me.aquitano.health.application.metric.heart.repository

import me.aquitano.health.application.metric.common.repository.*
import me.aquitano.health.infrastructure.database.tables.*
import me.aquitano.health.infrastructure.database.toApiString
import me.aquitano.health.infrastructure.repositories.common.BaseMetricRepository
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.jdbc.*

class HeartRateRepository : BaseMetricRepository() {
    fun listHeartRateSamples(filters: ReadFilters): Pair<List<HeartRateSampleRow>, Map<Int, SourceMetadata>> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = HeartRateSamplesTable.sourceInstanceId,
            fromColumn = HeartRateSamplesTable.measuredAt,
        ).whereOrNull() ?: return emptyReadResult()

        val rows = HeartRateSamplesTable.selectAll()
            .where(where)
            .orderBy(
                HeartRateSamplesTable.measuredAt to filters.sortOrder(),
                HeartRateSamplesTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map {
                HeartRateSampleRow(
                    id = it[HeartRateSamplesTable.id].value,
                    sourceInstanceId = it[HeartRateSamplesTable.sourceInstanceId],
                    measuredAt = it[HeartRateSamplesTable.measuredAt].toApiString(),
                    bpm = it[HeartRateSamplesTable.bpm],
                    context = it[HeartRateSamplesTable.context] ?: "unknown",
                )
            }
        return rows to sourceMetadata(
            rows.map { it.sourceInstanceId }.toSet(),
            filters.includeSource
        )
    }

    fun listHeartRateSamplesForWindow(filters: ReadFilters): Pair<List<HeartRateSampleRow>, Map<Int, SourceMetadata>> =
        listHeartRateSamples(
            filters.copy(
                limit = Int.MAX_VALUE,
                sort = "measuredAt",
                order = "asc",
            )
        )

    fun latestHeartRateSample(filters: ReadFilters): Pair<HeartRateSampleRow?, Map<Int, SourceMetadata>> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = HeartRateSamplesTable.sourceInstanceId,
            fromColumn = HeartRateSamplesTable.measuredAt,
        ).whereOrNull() ?: return emptyLatestResult()

        val row = HeartRateSamplesTable.selectAll()
            .where(where)
            .orderBy(
                HeartRateSamplesTable.measuredAt to SortOrder.DESC,
                HeartRateSamplesTable.id to SortOrder.DESC,
            )
            .limit(1)
            .map {
                HeartRateSampleRow(
                    id = it[HeartRateSamplesTable.id].value,
                    sourceInstanceId = it[HeartRateSamplesTable.sourceInstanceId],
                    measuredAt = it[HeartRateSamplesTable.measuredAt].toApiString(),
                    bpm = it[HeartRateSamplesTable.bpm],
                    context = it[HeartRateSamplesTable.context] ?: "unknown",
                )
            }
            .singleOrNull()
        return row to sourceMetadata(
            listOfNotNull(row?.sourceInstanceId).toSet(),
            filters.includeSource
        )
    }

    fun summarizeHeartRate(filters: ReadFilters): HeartRateSummaryRow {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = HeartRateSamplesTable.sourceInstanceId,
            fromColumn = HeartRateSamplesTable.measuredAt,
        ).whereOrNull() ?: return HeartRateSummaryRow(
            count = 0,
            minBpm = null,
            maxBpm = null,
            avgBpm = null,
        )
        val countExpression = HeartRateSamplesTable.id.count()
        val minExpression = HeartRateSamplesTable.bpm.min()
        val maxExpression = HeartRateSamplesTable.bpm.max()
        val avgExpression = HeartRateSamplesTable.bpm.avg()
        return HeartRateSamplesTable
            .select(countExpression, minExpression, maxExpression, avgExpression)
            .where(where)
            .single()
            .let {
                HeartRateSummaryRow(
                    count = it[countExpression].toInt(),
                    minBpm = it[minExpression],
                    maxBpm = it[maxExpression],
                    avgBpm = it[avgExpression]?.toDouble(),
                )
            }
    }

    fun summarizeHeartRateForWindow(filters: ReadFilters): HeartRateSummaryRow =
        summarizeHeartRate(filters)


    private fun toHeartRateSampleRow(row: ResultRow): HeartRateSampleRow =
        HeartRateSampleRow(
            id = row[HeartRateSamplesTable.id].value,
            sourceInstanceId = row[HeartRateSamplesTable.sourceInstanceId],
            measuredAt = row[HeartRateSamplesTable.measuredAt].toApiString(),
            bpm = row[HeartRateSamplesTable.bpm],
            context = row[HeartRateSamplesTable.context] ?: "unknown",
        )
}

package me.aquitano.health.application.metric.steps.repository

import me.aquitano.health.application.metric.common.repository.*
import me.aquitano.health.infrastructure.database.tables.*
import me.aquitano.health.infrastructure.database.toApiString
import me.aquitano.health.infrastructure.repositories.common.BaseMetricRepository
import me.aquitano.health.infrastructure.repositories.common.TimeFilterMode
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.jdbc.*

class StepRepository : BaseMetricRepository() {
    fun listStepSamples(filters: ReadFilters): Pair<List<StepSampleRow>, Map<Int, SourceMetadata>> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = StepSamplesTable.sourceInstanceId,
            fromColumn = StepSamplesTable.startAt,
        ).whereOrNull() ?: return emptyReadResult()

        val rows = StepSamplesTable.selectAll()
            .where(where)
            .orderBy(
                StepSamplesTable.startAt to filters.sortOrder(),
                StepSamplesTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map {
                StepSampleRow(
                    id = it[StepSamplesTable.id].value,
                    sourceInstanceId = it[StepSamplesTable.sourceInstanceId],
                    startAt = it[StepSamplesTable.startAt].toApiString(),
                    endAt = it[StepSamplesTable.endAt].toApiString(),
                    steps = it[StepSamplesTable.steps],
                )
            }
        return rows to sourceMetadata(
            rows.map { it.sourceInstanceId }.toSet(),
            filters.includeSource
        )
    }

    fun listStepSamplesForWindow(filters: ReadFilters): Pair<List<StepSampleRow>, Map<Int, SourceMetadata>> {
        val conditionResult = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = StepSamplesTable.sourceInstanceId,
            fromColumn = StepSamplesTable.startAt,
            toColumn = StepSamplesTable.endAt,
            mode = TimeFilterMode.OVERLAPS_WINDOW,
        ).whereOrNull() ?: return emptyReadResult()

        val rows = StepSamplesTable.selectAll()
            .where(conditionResult)
            .orderBy(
                StepSamplesTable.startAt to SortOrder.ASC,
                StepSamplesTable.id to SortOrder.ASC,
            )
            .map(::toStepSampleRow)
        return rows to sourceMetadata(
            rows.map { it.sourceInstanceId }.toSet(),
            filters.includeSource
        )
    }

    fun listStepDailySummaries(filters: DailyReadFilters): Pair<List<StepDailySummaryRow>, Map<Int, SourceMetadata>> {
        val where = dateConditions(
            filters = filters,
            sourceInstanceIdColumn = StepDailySummariesTable.sourceInstanceId,
            dateColumn = StepDailySummariesTable.date,
        ).whereOrNull() ?: return emptyReadResult()

        val rows = StepDailySummariesTable.selectAll()
            .where(where)
            .orderBy(
                StepDailySummariesTable.date to filters.sortOrder(),
                StepDailySummariesTable.sourceInstanceId to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map {
                StepDailySummaryRow(
                    id = it[StepDailySummariesTable.id].value,
                    sourceInstanceId = it[StepDailySummariesTable.sourceInstanceId],
                    date = it[StepDailySummariesTable.date].toString(),
                    steps = it[StepDailySummariesTable.steps],
                    sampleCount = it[StepDailySummariesTable.sampleCount],
                )
            }
        return rows to sourceMetadata(
            rows.map { it.sourceInstanceId }.toSet(),
            filters.includeSource
        )
    }

    fun sumStepDailySummaries(filters: DailyReadFilters): DashboardStepsSummaryRow {
        val where = dateConditions(
            filters = filters,
            sourceInstanceIdColumn = StepDailySummariesTable.sourceInstanceId,
            dateColumn = StepDailySummariesTable.date,
        ).whereOrNull() ?: return DashboardStepsSummaryRow(
            steps = 0,
            sampleCount = 0,
        )
        val stepsExpression = StepDailySummariesTable.steps.sum()
        val sampleCountExpression = StepDailySummariesTable.sampleCount.sum()
        val row = StepDailySummariesTable
            .select(stepsExpression, sampleCountExpression)
            .where(where)
            .single()
        return DashboardStepsSummaryRow(
            steps = row[stepsExpression] ?: 0,
            sampleCount = row[sampleCountExpression] ?: 0,
        )
    }

    private fun toStepSampleRow(row: ResultRow): StepSampleRow =
        StepSampleRow(
            id = row[StepSamplesTable.id].value,
            sourceInstanceId = row[StepSamplesTable.sourceInstanceId],
            startAt = row[StepSamplesTable.startAt].toApiString(),
            endAt = row[StepSamplesTable.endAt].toApiString(),
            steps = row[StepSamplesTable.steps],
        )

}

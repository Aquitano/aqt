package me.aquitano.health.application.metric.steps.repository

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

class StepRepository : BaseMetricRepository() {
    fun listStepSamples(filters: ReadFilters): Pair<List<StepSampleRow>, Map<Int, SourceMetadata>> {
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return emptyList<StepSampleRow>() to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(StepSamplesTable.startAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(StepSamplesTable.startAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(StepSamplesTable.sourceInstanceId inList it) }
        val rows = StepSamplesTable.selectAll()
            .where(combineConditions(conditions))
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
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return emptyList<StepSampleRow>() to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(StepSamplesTable.endAt greater it.toDbTimestamp()) }
        filters.to?.let { conditions.add(StepSamplesTable.startAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(StepSamplesTable.sourceInstanceId inList it) }
        val rows = StepSamplesTable.selectAll()
            .where(combineConditions(conditions))
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
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return emptyList<StepDailySummaryRow>() to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.fromDate?.let { conditions.add(StepDailySummariesTable.date greaterEq it) }
        filters.toDate?.let { conditions.add(StepDailySummariesTable.date lessEq it) }
        sourceIds?.let { conditions.add(StepDailySummariesTable.sourceInstanceId inList it) }
        val rows = StepDailySummariesTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                StepDailySummariesTable.date to filters.sortOrder(),
                StepDailySummariesTable.sourceInstanceId to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map {
                StepDailySummaryRow(
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
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return DashboardStepsSummaryRow(
            steps = 0,
            sampleCount = 0,
        )
        val conditions = mutableListOf<Op<Boolean>>()
        filters.fromDate?.let { conditions.add(StepDailySummariesTable.date greaterEq it) }
        filters.toDate?.let { conditions.add(StepDailySummariesTable.date lessEq it) }
        sourceIds?.let { conditions.add(StepDailySummariesTable.sourceInstanceId inList it) }
        val stepsExpression = StepDailySummariesTable.steps.sum()
        val sampleCountExpression = StepDailySummariesTable.sampleCount.sum()
        val row = StepDailySummariesTable
            .select(stepsExpression, sampleCountExpression)
            .where(combineConditions(conditions))
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

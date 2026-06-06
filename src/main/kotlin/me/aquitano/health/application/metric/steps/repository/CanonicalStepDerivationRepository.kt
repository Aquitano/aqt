package me.aquitano.health.application.metric.steps.repository

import me.aquitano.health.application.metric.common.repository.ReadFilters
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.application.metric.common.repository.DailyReadFilters
import me.aquitano.health.infrastructure.database.tables.CanonicalStepDailySummariesTable
import me.aquitano.health.infrastructure.database.tables.StepDailySummariesTable
import me.aquitano.health.infrastructure.database.tables.CanonicalStepDayBucketContributionsTable
import me.aquitano.health.infrastructure.database.tables.CanonicalStepSamplesTable
import me.aquitano.health.infrastructure.database.tables.StepSamplesTable
import me.aquitano.health.infrastructure.database.toApiString
import me.aquitano.health.infrastructure.database.toDbTimestamp
import me.aquitano.health.infrastructure.repositories.common.BaseMetricRepository
import me.aquitano.health.infrastructure.repositories.common.TimeFilterMode
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.jdbc.*
import java.time.Instant
import java.time.LocalDate

data class CanonicalStepSampleOutput(
    val sampleId: Int,
    val sourceInstanceId: Int,
    val startAt: Instant,
    val endAt: Instant,
    val steps: Int,
)

data class CanonicalStepDailySummaryOutput(
    val stepDailySummaryId: Int,
    val sourceInstanceId: Int,
    val date: LocalDate,
    val steps: Int,
)

data class CanonicalStepBucketContributionOutput(
    val date: LocalDate,
    val sourceInstanceId: Int,
    val sampleId: Int,
    val bucketStartAt: Instant,
    val bucketEndAt: Instant,
    val value: Double,
    val computedAt: Instant,
)

data class CanonicalStepOutput(
    val date: LocalDate,
    val algorithmVersion: Int,
    val computedAt: Instant,
    val dailySummary: CanonicalStepDailySummaryOutput?,
    val samples: List<CanonicalStepSampleOutput>,
    val bucketContributions: List<CanonicalStepBucketContributionOutput>,
)



data class StepBucketContributionRow(
    val bucketStartAt: String,
    val bucketEndAt: String,
    val value: Double,
)

data class CanonicalDashboardStepsSummary(
    val steps: Int,
    val sampleCount: Int,
    val sourceInstanceIds: Set<Int>,
)

class CanonicalStepDerivationRepository : BaseMetricRepository() {
    fun listRawSamplesForDay(dayStart: Instant, dayEnd: Instant): List<StepSampleRow> =
        StepSamplesTable.selectAll()
            .where {
                (StepSamplesTable.startAt less dayEnd.toDbTimestamp()) and
                    (StepSamplesTable.endAt greater dayStart.toDbTimestamp())
            }
            .orderBy(StepSamplesTable.startAt to SortOrder.ASC, StepSamplesTable.id to SortOrder.ASC)
            .map(::toStepSampleRow)

    fun listRawDailySummariesForDay(date: LocalDate): List<StepDailySummaryRow> =
        me.aquitano.health.infrastructure.database.tables.StepDailySummariesTable.selectAll()
            .where {
                me.aquitano.health.infrastructure.database.tables.StepDailySummariesTable.date eq date
            }
            .map { row ->
                StepDailySummaryRow(
                    id = row[me.aquitano.health.infrastructure.database.tables.StepDailySummariesTable.id].value,
                    date = row[me.aquitano.health.infrastructure.database.tables.StepDailySummariesTable.date].toString(),
                    steps = row[me.aquitano.health.infrastructure.database.tables.StepDailySummariesTable.steps],
                    sourceInstanceId = row[me.aquitano.health.infrastructure.database.tables.StepDailySummariesTable.sourceInstanceId],
                    sampleCount = row[me.aquitano.health.infrastructure.database.tables.StepDailySummariesTable.sampleCount],
                )
            }

    fun persistCanonicalOutput(output: CanonicalStepOutput): Int {
        CanonicalStepDayBucketContributionsTable.deleteWhere {
            (CanonicalStepDayBucketContributionsTable.date eq output.date) and
                (CanonicalStepDayBucketContributionsTable.algorithmVersion eq output.algorithmVersion)
        }
        CanonicalStepSamplesTable.deleteWhere {
            (CanonicalStepSamplesTable.date eq output.date) and
                (CanonicalStepSamplesTable.algorithmVersion eq output.algorithmVersion)
        }
        me.aquitano.health.infrastructure.database.tables.CanonicalStepDailySummariesTable.deleteWhere {
            (me.aquitano.health.infrastructure.database.tables.CanonicalStepDailySummariesTable.date eq output.date) and
                (me.aquitano.health.infrastructure.database.tables.CanonicalStepDailySummariesTable.algorithmVersion eq output.algorithmVersion)
        }
        output.dailySummary?.let { summary ->
            me.aquitano.health.infrastructure.database.tables.CanonicalStepDailySummariesTable.insert {
                it[date] = summary.date
                it[sourceInstanceId] = summary.sourceInstanceId
                it[stepDailySummaryId] = summary.stepDailySummaryId
                it[steps] = summary.steps
                it[algorithmVersion] = output.algorithmVersion
                it[computedAt] = output.computedAt.toDbTimestamp()
            }
        }
        CanonicalStepSamplesTable.batchInsert(output.samples) { sample ->
            this[CanonicalStepSamplesTable.date] = output.date
            this[CanonicalStepSamplesTable.sourceInstanceId] = sample.sourceInstanceId
            this[CanonicalStepSamplesTable.stepSampleId] = sample.sampleId
            this[CanonicalStepSamplesTable.startAt] = sample.startAt.toDbTimestamp()
            this[CanonicalStepSamplesTable.endAt] = sample.endAt.toDbTimestamp()
            this[CanonicalStepSamplesTable.steps] = sample.steps
            this[CanonicalStepSamplesTable.algorithmVersion] = output.algorithmVersion
            this[CanonicalStepSamplesTable.computedAt] = output.computedAt.toDbTimestamp()
        }
        CanonicalStepDayBucketContributionsTable.batchInsert(output.bucketContributions) { contribution ->
            this[CanonicalStepDayBucketContributionsTable.date] = contribution.date
            this[CanonicalStepDayBucketContributionsTable.sourceInstanceId] = contribution.sourceInstanceId
            this[CanonicalStepDayBucketContributionsTable.stepSampleId] = contribution.sampleId
            this[CanonicalStepDayBucketContributionsTable.bucketStartAt] = contribution.bucketStartAt.toDbTimestamp()
            this[CanonicalStepDayBucketContributionsTable.bucketEndAt] = contribution.bucketEndAt.toDbTimestamp()
            this[CanonicalStepDayBucketContributionsTable.value] = contribution.value
            this[CanonicalStepDayBucketContributionsTable.algorithmVersion] = output.algorithmVersion
            this[CanonicalStepDayBucketContributionsTable.computedAt] = contribution.computedAt.toDbTimestamp()
        }
        return output.samples.size
    }

    fun listCanonicalStepSamples(
        filters: ReadFilters,
        algorithmVersion: Int,
        overlapsWindow: Boolean = false,
    ): Pair<List<StepSampleRow>, Map<Int, SourceMetadata>> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = CanonicalStepSamplesTable.sourceInstanceId,
            fromColumn = CanonicalStepSamplesTable.startAt,
            toColumn = CanonicalStepSamplesTable.endAt,
            mode = if (overlapsWindow) TimeFilterMode.OVERLAPS_WINDOW else TimeFilterMode.START_AT_IN_RANGE,
        ).whereOrNull() ?: return emptyReadResult()

        val rows = CanonicalStepSamplesTable
            .innerJoin(StepSamplesTable, { stepSampleId }, { StepSamplesTable.id })
            .selectAll()
            .where(where and (CanonicalStepSamplesTable.algorithmVersion eq algorithmVersion))
            .orderBy(
                CanonicalStepSamplesTable.startAt to filters.sortOrder(),
                StepSamplesTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map(::toJoinedStepSampleRow)
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
    }

    fun listCanonicalStepDailySummaries(
        filters: DailyReadFilters,
        algorithmVersion: Int,
    ): Pair<List<StepDailySummaryRow>, Map<Int, SourceMetadata>> {
        val where = dateConditions(
            filters = filters,
            sourceInstanceIdColumn = CanonicalStepDailySummariesTable.sourceInstanceId,
            dateColumn = CanonicalStepDailySummariesTable.date,
        ).whereOrNull() ?: return emptyReadResult()

        val rows = CanonicalStepDailySummariesTable
            .innerJoin(StepDailySummariesTable, onColumn = { stepDailySummaryId }, otherColumn = { id })
            .selectAll()
            .where { where and (CanonicalStepDailySummariesTable.algorithmVersion eq algorithmVersion) }
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
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
    }

    fun listBucketContributions(
        filters: ReadFilters,
        algorithmVersion: Int,
    ): List<StepBucketContributionRow> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = CanonicalStepDayBucketContributionsTable.sourceInstanceId,
            fromColumn = CanonicalStepDayBucketContributionsTable.bucketStartAt,
        ).whereOrNull() ?: return emptyList()

        return CanonicalStepDayBucketContributionsTable.selectAll()
            .where(where and (CanonicalStepDayBucketContributionsTable.algorithmVersion eq algorithmVersion))
            .orderBy(CanonicalStepDayBucketContributionsTable.bucketStartAt to SortOrder.ASC)
            .map {
                StepBucketContributionRow(
                    bucketStartAt = it[CanonicalStepDayBucketContributionsTable.bucketStartAt].toApiString(),
                    bucketEndAt = it[CanonicalStepDayBucketContributionsTable.bucketEndAt].toApiString(),
                    value = it[CanonicalStepDayBucketContributionsTable.value],
                )
            }
    }

    fun summarizeCanonicalStepsForDashboard(
        filters: DailyReadFilters,
        algorithmVersion: Int,
    ): Pair<CanonicalDashboardStepsSummary, Map<Int, SourceMetadata>> {
        val contributionWhere = dateConditions(
            filters = filters,
            sourceInstanceIdColumn = CanonicalStepDayBucketContributionsTable.sourceInstanceId,
            dateColumn = CanonicalStepDayBucketContributionsTable.date,
        ).whereOrNull() ?: return emptyDashboardStepSummary(filters.includeSource)
        val sampleWhere = dateConditions(
            filters = filters,
            sourceInstanceIdColumn = CanonicalStepSamplesTable.sourceInstanceId,
            dateColumn = CanonicalStepSamplesTable.date,
        ).whereOrNull() ?: return emptyDashboardStepSummary(filters.includeSource)

        val valueExpression = CanonicalStepDayBucketContributionsTable.value.sum()
        val stepsBySource = CanonicalStepDayBucketContributionsTable
            .select(CanonicalStepDayBucketContributionsTable.sourceInstanceId, valueExpression)
            .where(contributionWhere and (CanonicalStepDayBucketContributionsTable.algorithmVersion eq algorithmVersion))
            .groupBy(CanonicalStepDayBucketContributionsTable.sourceInstanceId)
            .associate {
                it[CanonicalStepDayBucketContributionsTable.sourceInstanceId] to
                    ((it[valueExpression] ?: 0.0).toInt())
            }

        val countExpression = CanonicalStepSamplesTable.stepSampleId.count()
        val sampleCountsBySource = CanonicalStepSamplesTable
            .select(CanonicalStepSamplesTable.sourceInstanceId, countExpression)
            .where(sampleWhere and (CanonicalStepSamplesTable.algorithmVersion eq algorithmVersion))
            .groupBy(CanonicalStepSamplesTable.sourceInstanceId)
            .associate {
                it[CanonicalStepSamplesTable.sourceInstanceId] to it[countExpression].toInt()
            }

        val sourceIds = stepsBySource.keys + sampleCountsBySource.keys
        val summary = CanonicalDashboardStepsSummary(
            steps = stepsBySource.values.sum(),
            sampleCount = sampleCountsBySource.values.sum(),
            sourceInstanceIds = sourceIds,
        )
        return summary to sourceMetadata(sourceIds, filters.includeSource)
    }

    private fun emptyDashboardStepSummary(
        includeSource: Boolean,
    ): Pair<CanonicalDashboardStepsSummary, Map<Int, SourceMetadata>> =
        CanonicalDashboardStepsSummary(
            steps = 0,
            sampleCount = 0,
            sourceInstanceIds = emptySet(),
        ) to sourceMetadata(emptySet(), includeSource)

    private fun toJoinedStepSampleRow(row: ResultRow): StepSampleRow =
        StepSampleRow(
            id = row[StepSamplesTable.id].value,
            sourceInstanceId = row[StepSamplesTable.sourceInstanceId],
            startAt = row[StepSamplesTable.startAt].toApiString(),
            endAt = row[StepSamplesTable.endAt].toApiString(),
            steps = row[StepSamplesTable.steps],
        )

    private fun toStepSampleRow(row: ResultRow): StepSampleRow =
        StepSampleRow(
            id = row[StepSamplesTable.id].value,
            sourceInstanceId = row[StepSamplesTable.sourceInstanceId],
            startAt = row[StepSamplesTable.startAt].toApiString(),
            endAt = row[StepSamplesTable.endAt].toApiString(),
            steps = row[StepSamplesTable.steps],
        )
}

package me.aquitano.health.application.metric.respiratory.repository

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

class RespiratoryRateRepository : BaseMetricRepository() {
    fun listRespiratoryRateSamples(filters: ReadFilters): Pair<List<RespiratoryRateSampleRow>, Map<Int, SourceMetadata>> {
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return emptyList<RespiratoryRateSampleRow>() to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(RespiratoryRateSamplesTable.measuredAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(RespiratoryRateSamplesTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(RespiratoryRateSamplesTable.sourceInstanceId inList it) }
        val rows = RespiratoryRateSamplesTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                RespiratoryRateSamplesTable.measuredAt to filters.sortOrder(),
                RespiratoryRateSamplesTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map(::toRespiratoryRateSampleRow)
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
    }

    fun latestRespiratoryRateSample(filters: ReadFilters): Pair<RespiratoryRateSampleRow?, Map<Int, SourceMetadata>> {
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return null to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(RespiratoryRateSamplesTable.measuredAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(RespiratoryRateSamplesTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(RespiratoryRateSamplesTable.sourceInstanceId inList it) }
        val row = RespiratoryRateSamplesTable.selectAll()
            .where(combineConditions(conditions))
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
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return RespiratoryRateSummaryRow(0, null, null, null)
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(RespiratoryRateSamplesTable.measuredAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(RespiratoryRateSamplesTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(RespiratoryRateSamplesTable.sourceInstanceId inList it) }
        val countExpression = RespiratoryRateSamplesTable.id.count()
        val minExpression = RespiratoryRateSamplesTable.breathsPerMinute.min()
        val maxExpression = RespiratoryRateSamplesTable.breathsPerMinute.max()
        val avgExpression = RespiratoryRateSamplesTable.breathsPerMinute.avg()
        return RespiratoryRateSamplesTable
            .select(countExpression, minExpression, maxExpression, avgExpression)
            .where(combineConditions(conditions))
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
            measuredAt = row[RespiratoryRateSamplesTable.measuredAt].toApiString(),
            breathsPerMinute = row[RespiratoryRateSamplesTable.breathsPerMinute],
            context = row[RespiratoryRateSamplesTable.context] ?: "unknown",
        )

}

package me.aquitano.health.application.metric.hrv.repository

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

class HrvRepository : BaseMetricRepository() {
    fun listHrvSamples(filters: ReadFilters, metricType: String): Pair<List<HrvSampleRow>, Map<Int, SourceMetadata>> {
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return emptyList<HrvSampleRow>() to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(HrvSamplesTable.measuredAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(HrvSamplesTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(HrvSamplesTable.sourceInstanceId inList it) }
        conditions.add(HrvSamplesTable.metricType eq metricType)
        val rows = HrvSamplesTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                HrvSamplesTable.measuredAt to filters.sortOrder(),
                HrvSamplesTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map(::toHrvSampleRow)
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
    }

    fun latestHrvSample(filters: ReadFilters, metricType: String): Pair<HrvSampleRow?, Map<Int, SourceMetadata>> {
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return null to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(HrvSamplesTable.measuredAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(HrvSamplesTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(HrvSamplesTable.sourceInstanceId inList it) }
        conditions.add(HrvSamplesTable.metricType eq metricType)
        val row = HrvSamplesTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                HrvSamplesTable.measuredAt to SortOrder.DESC,
                HrvSamplesTable.id to SortOrder.DESC,
            )
            .limit(1)
            .map(::toHrvSampleRow)
            .singleOrNull()
        return row to sourceMetadata(listOfNotNull(row?.sourceInstanceId).toSet(), filters.includeSource)
    }

    fun summarizeHrv(filters: ReadFilters, metricType: String): HrvSummaryRow {
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return HrvSummaryRow(0, null, null, null)
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(HrvSamplesTable.measuredAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(HrvSamplesTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(HrvSamplesTable.sourceInstanceId inList it) }
        conditions.add(HrvSamplesTable.metricType eq metricType)
        val countExpression = HrvSamplesTable.id.count()
        val minExpression = HrvSamplesTable.value.min()
        val maxExpression = HrvSamplesTable.value.max()
        val avgExpression = HrvSamplesTable.value.avg()
        return HrvSamplesTable
            .select(countExpression, minExpression, maxExpression, avgExpression)
            .where(combineConditions(conditions))
            .single()
            .let {
                HrvSummaryRow(
                    count = it[countExpression].toInt(),
                    minValue = it[minExpression],
                    maxValue = it[maxExpression],
                    avgValue = it[avgExpression]?.toDouble(),
                )
            }
    }

    private fun toHrvSampleRow(row: ResultRow): HrvSampleRow =
        HrvSampleRow(
            id = row[HrvSamplesTable.id].value,
            sourceInstanceId = row[HrvSamplesTable.sourceInstanceId],
            measuredAt = row[HrvSamplesTable.measuredAt].toApiString(),
            metricType = row[HrvSamplesTable.metricType],
            value = row[HrvSamplesTable.value],
            unit = row[HrvSamplesTable.unit],
            context = row[HrvSamplesTable.context] ?: "unknown",
        )

}

package me.aquitano.health.application.metric.hrv.repository

import me.aquitano.health.application.metric.common.repository.ReadFilters
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.application.metric.hrv.derived.CanonicalHrvOutput
import me.aquitano.health.infrastructure.database.tables.CanonicalHrvSamplesTable
import me.aquitano.health.infrastructure.database.tables.HrvSamplesTable
import me.aquitano.health.infrastructure.database.toApiString
import me.aquitano.health.infrastructure.database.toDbTimestamp
import me.aquitano.health.infrastructure.repositories.common.BaseMetricRepository
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.jdbc.*
import java.time.Instant
import java.time.LocalDate

class CanonicalHrvDerivationRepository : BaseMetricRepository() {
    fun listRawSamplesForDay(dayStart: Instant, dayEnd: Instant): List<HrvSampleRow> =
        HrvSamplesTable.selectAll()
            .where {
                (HrvSamplesTable.measuredAt greaterEq dayStart.toDbTimestamp()) and
                    (HrvSamplesTable.measuredAt less dayEnd.toDbTimestamp())
            }
            .orderBy(HrvSamplesTable.measuredAt to SortOrder.ASC, HrvSamplesTable.id to SortOrder.ASC)
            .map(::toHrvSampleRow)

    fun persistCanonicalSamples(output: CanonicalHrvOutput): Int {
        CanonicalHrvSamplesTable.deleteWhere {
            (CanonicalHrvSamplesTable.date eq output.date) and
                (CanonicalHrvSamplesTable.algorithmVersion eq output.algorithmVersion)
        }
        CanonicalHrvSamplesTable.batchInsert(output.samples) { sample ->
            this[CanonicalHrvSamplesTable.date] = output.date
            this[CanonicalHrvSamplesTable.sourceInstanceId] = sample.sourceInstanceId
            this[CanonicalHrvSamplesTable.hrvSampleId] = sample.sampleId
            this[CanonicalHrvSamplesTable.measuredAt] = sample.measuredAt.toDbTimestamp()
            this[CanonicalHrvSamplesTable.metricType] = sample.metricType
            this[CanonicalHrvSamplesTable.context] = sample.context
            this[CanonicalHrvSamplesTable.algorithmVersion] = output.algorithmVersion
            this[CanonicalHrvSamplesTable.computedAt] = output.computedAt.toDbTimestamp()
        }
        return output.samples.size
    }

    fun listCanonicalHrvSamples(
        filters: ReadFilters,
        metricType: String,
        algorithmVersion: Int,
    ): Pair<List<HrvSampleRow>, Map<Int, SourceMetadata>> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = CanonicalHrvSamplesTable.sourceInstanceId,
            fromColumn = CanonicalHrvSamplesTable.measuredAt,
        ).whereOrNull() ?: return emptyReadResult()

        val rows = CanonicalHrvSamplesTable
            .innerJoin(
                HrvSamplesTable,
                { hrvSampleId },
                { HrvSamplesTable.id },
            )
            .selectAll()
            .where(
                where and
                    (CanonicalHrvSamplesTable.algorithmVersion eq algorithmVersion) and
                    (CanonicalHrvSamplesTable.metricType eq metricType)
            )
            .orderBy(
                CanonicalHrvSamplesTable.measuredAt to filters.sortOrder(),
                HrvSamplesTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map(::toJoinedHrvSampleRow)
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
    }

    fun materializedDates(dates: Set<LocalDate>, algorithmVersion: Int): Set<LocalDate> {
        if (dates.isEmpty()) return emptySet()
        return CanonicalHrvSamplesTable
            .select(CanonicalHrvSamplesTable.date)
            .where {
                (CanonicalHrvSamplesTable.date inList dates) and
                    (CanonicalHrvSamplesTable.algorithmVersion eq algorithmVersion)
            }
            .map { it[CanonicalHrvSamplesTable.date] }
            .toSet()
    }

    private fun toJoinedHrvSampleRow(row: ResultRow): HrvSampleRow =
        HrvSampleRow(
            id = row[HrvSamplesTable.id].value,
            sourceInstanceId = row[HrvSamplesTable.sourceInstanceId],
            measuredAt = row[HrvSamplesTable.measuredAt].toApiString(),
            metricType = row[HrvSamplesTable.metricType],
            value = row[HrvSamplesTable.value],
            unit = row[HrvSamplesTable.unit],
            context = row[HrvSamplesTable.context] ?: "unknown",
        )

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

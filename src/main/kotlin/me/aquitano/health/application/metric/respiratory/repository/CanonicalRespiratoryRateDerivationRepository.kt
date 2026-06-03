package me.aquitano.health.application.metric.respiratory.repository

import me.aquitano.health.application.metric.common.repository.ReadFilters
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.application.metric.respiratory.derived.CanonicalRespiratoryRateOutput
import me.aquitano.health.infrastructure.database.tables.CanonicalRespiratoryRateSamplesTable
import me.aquitano.health.infrastructure.database.tables.RespiratoryRateSamplesTable
import me.aquitano.health.infrastructure.database.toApiString
import me.aquitano.health.infrastructure.database.toDbTimestamp
import me.aquitano.health.infrastructure.repositories.common.BaseMetricRepository
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.jdbc.*
import java.time.Instant
import java.time.LocalDate

class CanonicalRespiratoryRateDerivationRepository : BaseMetricRepository() {
    fun listRawSamplesForDay(dayStart: Instant, dayEnd: Instant): List<RespiratoryRateSampleRow> =
        RespiratoryRateSamplesTable.selectAll()
            .where {
                (RespiratoryRateSamplesTable.measuredAt greaterEq dayStart.toDbTimestamp()) and
                    (RespiratoryRateSamplesTable.measuredAt less dayEnd.toDbTimestamp())
            }
            .orderBy(
                RespiratoryRateSamplesTable.measuredAt to SortOrder.ASC,
                RespiratoryRateSamplesTable.id to SortOrder.ASC,
            )
            .map(::toRespiratoryRateSampleRow)

    fun persistCanonicalSamples(output: CanonicalRespiratoryRateOutput): Int {
        CanonicalRespiratoryRateSamplesTable.deleteWhere {
            (CanonicalRespiratoryRateSamplesTable.date eq output.date) and
                (CanonicalRespiratoryRateSamplesTable.algorithmVersion eq output.algorithmVersion)
        }
        CanonicalRespiratoryRateSamplesTable.batchInsert(output.samples) { sample ->
            this[CanonicalRespiratoryRateSamplesTable.date] = output.date
            this[CanonicalRespiratoryRateSamplesTable.sourceInstanceId] = sample.sourceInstanceId
            this[CanonicalRespiratoryRateSamplesTable.respiratoryRateSampleId] = sample.sampleId
            this[CanonicalRespiratoryRateSamplesTable.measuredAt] = sample.measuredAt.toDbTimestamp()
            this[CanonicalRespiratoryRateSamplesTable.context] = sample.context
            this[CanonicalRespiratoryRateSamplesTable.algorithmVersion] = output.algorithmVersion
            this[CanonicalRespiratoryRateSamplesTable.computedAt] = output.computedAt.toDbTimestamp()
        }
        return output.samples.size
    }

    fun listCanonicalRespiratoryRateSamples(
        filters: ReadFilters,
        algorithmVersion: Int,
    ): Pair<List<RespiratoryRateSampleRow>, Map<Int, SourceMetadata>> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = CanonicalRespiratoryRateSamplesTable.sourceInstanceId,
            fromColumn = CanonicalRespiratoryRateSamplesTable.measuredAt,
        ).whereOrNull() ?: return emptyReadResult()

        val rows = CanonicalRespiratoryRateSamplesTable
            .innerJoin(
                RespiratoryRateSamplesTable,
                { respiratoryRateSampleId },
                { RespiratoryRateSamplesTable.id },
            )
            .selectAll()
            .where(where and (CanonicalRespiratoryRateSamplesTable.algorithmVersion eq algorithmVersion))
            .orderBy(
                CanonicalRespiratoryRateSamplesTable.measuredAt to filters.sortOrder(),
                RespiratoryRateSamplesTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map(::toJoinedRespiratoryRateSampleRow)
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
    }

    fun materializedDates(dates: Set<LocalDate>, algorithmVersion: Int): Set<LocalDate> {
        if (dates.isEmpty()) return emptySet()
        return CanonicalRespiratoryRateSamplesTable
            .select(CanonicalRespiratoryRateSamplesTable.date)
            .where {
                (CanonicalRespiratoryRateSamplesTable.date inList dates) and
                    (CanonicalRespiratoryRateSamplesTable.algorithmVersion eq algorithmVersion)
            }
            .map { it[CanonicalRespiratoryRateSamplesTable.date] }
            .toSet()
    }

    private fun toJoinedRespiratoryRateSampleRow(row: ResultRow): RespiratoryRateSampleRow =
        RespiratoryRateSampleRow(
            id = row[RespiratoryRateSamplesTable.id].value,
            sourceInstanceId = row[RespiratoryRateSamplesTable.sourceInstanceId],
            measuredAt = row[RespiratoryRateSamplesTable.measuredAt].toApiString(),
            breathsPerMinute = row[RespiratoryRateSamplesTable.breathsPerMinute],
            context = row[RespiratoryRateSamplesTable.context] ?: "unknown",
        )

    private fun toRespiratoryRateSampleRow(row: ResultRow): RespiratoryRateSampleRow =
        RespiratoryRateSampleRow(
            id = row[RespiratoryRateSamplesTable.id].value,
            sourceInstanceId = row[RespiratoryRateSamplesTable.sourceInstanceId],
            measuredAt = row[RespiratoryRateSamplesTable.measuredAt].toApiString(),
            breathsPerMinute = row[RespiratoryRateSamplesTable.breathsPerMinute],
            context = row[RespiratoryRateSamplesTable.context] ?: "unknown",
        )
}

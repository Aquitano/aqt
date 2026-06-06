package me.aquitano.health.application.metric.body.repository

import me.aquitano.health.application.metric.common.repository.ReadFilters
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.infrastructure.database.tables.BodyMeasurementsTable
import me.aquitano.health.infrastructure.database.tables.CanonicalBodyMeasurementsTable
import me.aquitano.health.infrastructure.database.toApiString
import me.aquitano.health.infrastructure.database.toDbTimestamp
import me.aquitano.health.infrastructure.repositories.common.BaseMetricRepository
import me.aquitano.health.infrastructure.repositories.common.TimeFilterMode
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.jdbc.*
import java.time.Instant
import java.time.LocalDate

data class CanonicalBodyMeasurementRowOutput(
    val measurementId: Int,
    val sourceInstanceId: Int,
    val measuredAt: Instant,
    val metricType: String,
)

data class CanonicalBodyMeasurementOutput(
    val date: LocalDate,
    val algorithmVersion: Int,
    val computedAt: Instant,
    val measurements: List<CanonicalBodyMeasurementRowOutput>,
)

class CanonicalBodyMeasurementDerivationRepository : BaseMetricRepository() {
    fun listRawMeasurementsForDay(dayStart: Instant, dayEnd: Instant): List<BodyMeasurementRow> =
        BodyMeasurementsTable.selectAll()
            .where {
                (BodyMeasurementsTable.measuredAt greaterEq dayStart.toDbTimestamp()) and
                    (BodyMeasurementsTable.measuredAt less dayEnd.toDbTimestamp())
            }
            .orderBy(
                BodyMeasurementsTable.measuredAt to SortOrder.ASC,
                BodyMeasurementsTable.metricType to SortOrder.ASC,
                BodyMeasurementsTable.id to SortOrder.ASC,
            )
            .map(::toBodyMeasurementRow)

    fun persistCanonicalOutput(output: CanonicalBodyMeasurementOutput): Int {
        CanonicalBodyMeasurementsTable.deleteWhere {
            (CanonicalBodyMeasurementsTable.date eq output.date) and
                (CanonicalBodyMeasurementsTable.algorithmVersion eq output.algorithmVersion)
        }
        CanonicalBodyMeasurementsTable.batchInsert(output.measurements) { measurement ->
            this[CanonicalBodyMeasurementsTable.date] = output.date
            this[CanonicalBodyMeasurementsTable.sourceInstanceId] = measurement.sourceInstanceId
            this[CanonicalBodyMeasurementsTable.bodyMeasurementId] = measurement.measurementId
            this[CanonicalBodyMeasurementsTable.measuredAt] = measurement.measuredAt.toDbTimestamp()
            this[CanonicalBodyMeasurementsTable.metricType] = measurement.metricType
            this[CanonicalBodyMeasurementsTable.algorithmVersion] = output.algorithmVersion
            this[CanonicalBodyMeasurementsTable.computedAt] = output.computedAt.toDbTimestamp()
        }
        return output.measurements.size
    }

    fun listCanonicalBodyMeasurements(
        filters: ReadFilters,
        metricType: String?,
        algorithmVersion: Int,
    ): Pair<List<BodyMeasurementRow>, Map<Int, SourceMetadata>> {
        var where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = CanonicalBodyMeasurementsTable.sourceInstanceId,
            fromColumn = CanonicalBodyMeasurementsTable.measuredAt,
        ).whereOrNull() ?: return emptyReadResult()
        metricType?.let { where = where and (CanonicalBodyMeasurementsTable.metricType eq it) }

        val rows = CanonicalBodyMeasurementsTable
            .innerJoin(BodyMeasurementsTable, { bodyMeasurementId }, { BodyMeasurementsTable.id })
            .selectAll()
            .where(where and (CanonicalBodyMeasurementsTable.algorithmVersion eq algorithmVersion))
            .orderBy(
                CanonicalBodyMeasurementsTable.measuredAt to filters.sortOrder(),
                CanonicalBodyMeasurementsTable.metricType to filters.sortOrder(),
                BodyMeasurementsTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map(::toJoinedBodyMeasurementRow)
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
    }

    fun latestCanonicalBodyMeasurement(
        filters: ReadFilters,
        metricType: String,
        algorithmVersion: Int,
    ): Pair<BodyMeasurementRow?, Map<Int, SourceMetadata>> {
        val row = listCanonicalBodyMeasurements(
            filters.copy(limit = 1, order = "desc"),
            metricType,
            algorithmVersion,
        ).first.singleOrNull()
        return row to sourceMetadata(listOfNotNull(row?.sourceInstanceId).toSet(), filters.includeSource)
    }

    fun latestCanonicalBodyMeasurementBefore(
        filters: ReadFilters,
        metricType: String,
        algorithmVersion: Int,
    ): Pair<BodyMeasurementRow?, Map<Int, SourceMetadata>> {
        var where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = CanonicalBodyMeasurementsTable.sourceInstanceId,
            fromColumn = CanonicalBodyMeasurementsTable.measuredAt,
            mode = TimeFilterMode.BEFORE_FROM,
        ).whereOrNull() ?: return emptyLatestResult()
        where = where and (CanonicalBodyMeasurementsTable.metricType eq metricType)

        val row = CanonicalBodyMeasurementsTable
            .innerJoin(BodyMeasurementsTable, { bodyMeasurementId }, { BodyMeasurementsTable.id })
            .selectAll()
            .where(where and (CanonicalBodyMeasurementsTable.algorithmVersion eq algorithmVersion))
            .orderBy(
                CanonicalBodyMeasurementsTable.measuredAt to SortOrder.DESC,
                BodyMeasurementsTable.id to SortOrder.DESC,
            )
            .limit(1)
            .map(::toJoinedBodyMeasurementRow)
            .singleOrNull()
        return row to sourceMetadata(listOfNotNull(row?.sourceInstanceId).toSet(), filters.includeSource)
    }

    private fun toJoinedBodyMeasurementRow(row: ResultRow): BodyMeasurementRow =
        BodyMeasurementRow(
            id = row[BodyMeasurementsTable.id].value,
            sourceInstanceId = row[BodyMeasurementsTable.sourceInstanceId],
            measuredAt = row[BodyMeasurementsTable.measuredAt].toApiString(),
            metricType = row[BodyMeasurementsTable.metricType],
            value = row[BodyMeasurementsTable.value],
            unit = row[BodyMeasurementsTable.unit],
        )

    private fun toBodyMeasurementRow(row: ResultRow): BodyMeasurementRow =
        BodyMeasurementRow(
            id = row[BodyMeasurementsTable.id].value,
            sourceInstanceId = row[BodyMeasurementsTable.sourceInstanceId],
            measuredAt = row[BodyMeasurementsTable.measuredAt].toApiString(),
            metricType = row[BodyMeasurementsTable.metricType],
            value = row[BodyMeasurementsTable.value],
            unit = row[BodyMeasurementsTable.unit],
        )
}

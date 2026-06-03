package me.aquitano.health.application.metric.cardiovascular.repository

import me.aquitano.health.application.metric.common.repository.*
import me.aquitano.health.infrastructure.database.tables.*
import me.aquitano.health.infrastructure.database.toApiString
import me.aquitano.health.infrastructure.repositories.common.BaseMetricRepository
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.jdbc.*

class CardiovascularRepository : BaseMetricRepository() {
    fun listBloodPressure(filters: ReadFilters): Pair<List<BloodPressureMeasurementRow>, Map<Int, SourceMetadata>> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = BloodPressureMeasurementsTable.sourceInstanceId,
            fromColumn = BloodPressureMeasurementsTable.measuredAt,
        ).whereOrNull() ?: return emptyReadResult()

        val rows = BloodPressureMeasurementsTable.selectAll()
            .where(where)
            .orderBy(
                BloodPressureMeasurementsTable.measuredAt to filters.sortOrder(),
                BloodPressureMeasurementsTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map(::toBloodPressureMeasurementRow)
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
    }

    fun latestBloodPressure(filters: ReadFilters): Pair<BloodPressureMeasurementRow?, Map<Int, SourceMetadata>> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = BloodPressureMeasurementsTable.sourceInstanceId,
            fromColumn = BloodPressureMeasurementsTable.measuredAt,
        ).whereOrNull() ?: return emptyLatestResult()

        val row = BloodPressureMeasurementsTable.selectAll()
            .where(where)
            .orderBy(
                BloodPressureMeasurementsTable.measuredAt to SortOrder.DESC,
                BloodPressureMeasurementsTable.id to SortOrder.DESC,
            )
            .limit(1)
            .map(::toBloodPressureMeasurementRow)
            .singleOrNull()
        return row to sourceMetadata(listOfNotNull(row?.sourceInstanceId).toSet(), filters.includeSource)
    }

    fun listCardiovascular(
        filters: ReadFilters,
        metricType: String?
    ): Pair<List<CardiovascularMeasurementRow>, Map<Int, SourceMetadata>> {
        var where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = CardiovascularMeasurementsTable.sourceInstanceId,
            fromColumn = CardiovascularMeasurementsTable.measuredAt,
        ).whereOrNull() ?: return emptyReadResult()
        metricType?.let { where = where and (CardiovascularMeasurementsTable.metricType eq it) }

        val rows = CardiovascularMeasurementsTable.selectAll()
            .where(where)
            .orderBy(
                CardiovascularMeasurementsTable.measuredAt to filters.sortOrder(),
                CardiovascularMeasurementsTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map(::toCardiovascularMeasurementRow)
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
    }

    fun latestCardiovascular(
        filters: ReadFilters,
        metricType: String
    ): Pair<CardiovascularMeasurementRow?, Map<Int, SourceMetadata>> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = CardiovascularMeasurementsTable.sourceInstanceId,
            fromColumn = CardiovascularMeasurementsTable.measuredAt,
        ).whereOrNull() ?: return emptyLatestResult()

        val row = CardiovascularMeasurementsTable.selectAll()
            .where(where and (CardiovascularMeasurementsTable.metricType eq metricType))
            .orderBy(
                CardiovascularMeasurementsTable.measuredAt to SortOrder.DESC,
                CardiovascularMeasurementsTable.id to SortOrder.DESC,
            )
            .limit(1)
            .map(::toCardiovascularMeasurementRow)
            .singleOrNull()
        return row to sourceMetadata(listOfNotNull(row?.sourceInstanceId).toSet(), filters.includeSource)
    }

    private fun toBloodPressureMeasurementRow(row: ResultRow): BloodPressureMeasurementRow =
        BloodPressureMeasurementRow(
            id = row[BloodPressureMeasurementsTable.id].value,
            sourceInstanceId = row[BloodPressureMeasurementsTable.sourceInstanceId],
            measuredAt = row[BloodPressureMeasurementsTable.measuredAt].toApiString(),
            systolicMmhg = row[BloodPressureMeasurementsTable.systolicMmhg],
            diastolicMmhg = row[BloodPressureMeasurementsTable.diastolicMmhg],
            heartRateBpm = row[BloodPressureMeasurementsTable.heartRateBpm],
        )

    private fun toCardiovascularMeasurementRow(row: ResultRow): CardiovascularMeasurementRow =
        CardiovascularMeasurementRow(
            id = row[CardiovascularMeasurementsTable.id].value,
            sourceInstanceId = row[CardiovascularMeasurementsTable.sourceInstanceId],
            measuredAt = row[CardiovascularMeasurementsTable.measuredAt].toApiString(),
            metricType = row[CardiovascularMeasurementsTable.metricType],
            value = row[CardiovascularMeasurementsTable.value],
            unit = row[CardiovascularMeasurementsTable.unit],
        )

}

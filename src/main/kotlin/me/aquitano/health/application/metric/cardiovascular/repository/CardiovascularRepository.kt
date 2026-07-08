package me.aquitano.health.application.metric.cardiovascular.repository

import me.aquitano.health.application.metric.common.keysetFetchLimit
import me.aquitano.health.application.metric.common.repository.*
import me.aquitano.health.infrastructure.database.tables.*
import me.aquitano.health.infrastructure.database.toApiString
import me.aquitano.health.application.metric.common.repository.BaseMetricReadRepository
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.jdbc.*

class CardiovascularRepository : BaseMetricReadRepository() {
    fun listBloodPressure(filters: ReadFilters): Pair<List<BloodPressureMeasurementRow>, Map<Int, SourceMetadata>> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = BloodPressureMeasurementsTable.sourceInstanceId,
            fromColumn = BloodPressureMeasurementsTable.measuredAt,
        ).whereOrNull() ?: return emptyReadResult()

        val keyset = timestampKeyset(
            filters.cursor,
            filters.order,
            BloodPressureMeasurementsTable.measuredAt,
            BloodPressureMeasurementsTable.id,
        )
        val rows = BloodPressureMeasurementsTable.selectAll()
            .where(where and (keyset ?: Op.TRUE))
            .orderBy(
                BloodPressureMeasurementsTable.measuredAt to filters.sortOrder(),
                BloodPressureMeasurementsTable.id to filters.sortOrder(),
            )
            .limit(keysetFetchLimit(filters.limit))
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

    private fun toBloodPressureMeasurementRow(row: ResultRow): BloodPressureMeasurementRow =
        BloodPressureMeasurementRow(
            id = row[BloodPressureMeasurementsTable.id].value,
            sourceInstanceId = row[BloodPressureMeasurementsTable.sourceInstanceId],
            measuredAt = row[BloodPressureMeasurementsTable.measuredAt].toApiString(),
            systolicMmhg = row[BloodPressureMeasurementsTable.systolicMmhg],
            diastolicMmhg = row[BloodPressureMeasurementsTable.diastolicMmhg],
            heartRateBpm = row[BloodPressureMeasurementsTable.heartRateBpm],
        )
}

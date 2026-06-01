package me.aquitano.health.application.metric.body.repository

import me.aquitano.health.application.metric.common.repository.*
import me.aquitano.health.infrastructure.database.tables.*
import me.aquitano.health.infrastructure.database.toApiString
import me.aquitano.health.infrastructure.database.toDbTimestamp
import me.aquitano.health.infrastructure.repositories.common.BaseMetricRepository
import me.aquitano.health.infrastructure.repositories.common.TimeFilterMode
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.inList
import org.jetbrains.exposed.v1.core.less
import org.jetbrains.exposed.v1.jdbc.*
import java.time.Instant

class BodyMeasurementRepository : BaseMetricRepository() {
    fun listBodyMeasurements(
        filters: ReadFilters,
        metricType: String?
    ): Pair<List<BodyMeasurementRow>, Map<Int, SourceMetadata>> {
        var where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = BodyMeasurementsTable.sourceInstanceId,
            fromColumn = BodyMeasurementsTable.measuredAt,
        ).whereOrNull() ?: return emptyReadResult()
        metricType?.let { where = where and (BodyMeasurementsTable.metricType eq it) }

        val rows = BodyMeasurementsTable.selectAll()
            .where(where)
            .orderBy(
                BodyMeasurementsTable.measuredAt to filters.sortOrder(),
                BodyMeasurementsTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map {
                BodyMeasurementRow(
                    id = it[BodyMeasurementsTable.id].value,
                    sourceInstanceId = it[BodyMeasurementsTable.sourceInstanceId],
                    measuredAt = it[BodyMeasurementsTable.measuredAt].toApiString(),
                    metricType = it[BodyMeasurementsTable.metricType],
                    value = it[BodyMeasurementsTable.value],
                    unit = it[BodyMeasurementsTable.unit],
                )
            }
        return rows to sourceMetadata(
            rows.map { it.sourceInstanceId }.toSet(),
            filters.includeSource
        )
    }

    fun listBodyMeasurementsForWindow(
        filters: ReadFilters,
        metricType: String
    ): Pair<List<BodyMeasurementRow>, Map<Int, SourceMetadata>> =
        listBodyMeasurements(filters, metricType)

    fun latestBodyMeasurementBefore(
        filters: ReadFilters,
        metricType: String
    ): Pair<BodyMeasurementRow?, Map<Int, SourceMetadata>> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = BodyMeasurementsTable.sourceInstanceId,
            fromColumn = BodyMeasurementsTable.measuredAt,
            mode = TimeFilterMode.BEFORE_FROM,
        ).whereOrNull() ?: return emptyLatestResult()

        val row = BodyMeasurementsTable.selectAll()
            .where(where and (BodyMeasurementsTable.metricType eq metricType))
            .orderBy(
                BodyMeasurementsTable.measuredAt to SortOrder.DESC,
                BodyMeasurementsTable.id to SortOrder.DESC,
            )
            .limit(1)
            .map(::toBodyMeasurementRow)
            .singleOrNull()
        return row to sourceMetadata(
            listOfNotNull(row?.sourceInstanceId).toSet(),
            filters.includeSource
        )
    }

    fun latestBodyMeasurementsBefore(
        filters: ReadFilters,
        metricType: String
    ): Pair<List<BodyMeasurementRow>, Map<Int, SourceMetadata>> {
        val sourceIds = filters.sourceInstanceIds()
        if (sourceIds.hasNoMatchingSources()) return emptyReadResult()
        val latestWhere = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = BodyMeasurementsTable.sourceInstanceId,
            fromColumn = BodyMeasurementsTable.measuredAt,
            mode = TimeFilterMode.BEFORE_FROM,
        ).whereOrNull() ?: return emptyReadResult()

        val latestMeasuredAt = BodyMeasurementsTable.selectAll()
            .where(latestWhere and (BodyMeasurementsTable.metricType eq metricType))
            .orderBy(
                BodyMeasurementsTable.measuredAt to SortOrder.DESC,
                BodyMeasurementsTable.id to SortOrder.DESC,
            )
            .limit(1)
            .map { it[BodyMeasurementsTable.measuredAt] }
            .singleOrNull()
            ?: return emptyReadResult()

        val conflictConditions = mutableListOf<Op<Boolean>>(
            BodyMeasurementsTable.measuredAt eq latestMeasuredAt,
            BodyMeasurementsTable.metricType eq metricType,
        )
        sourceIds?.let { conflictConditions.add(BodyMeasurementsTable.sourceInstanceId inList it) }
        val rows = BodyMeasurementsTable.selectAll()
            .where(combineConditions(conflictConditions))
            .orderBy(BodyMeasurementsTable.id to SortOrder.ASC)
            .map(::toBodyMeasurementRow)
        return rows to sourceMetadata(
            rows.map { it.sourceInstanceId }.toSet(),
            filters.includeSource
        )
    }

    fun latestBodyMeasurement(
        filters: ReadFilters,
        metricType: String?
    ): Pair<BodyMeasurementRow?, Map<Int, SourceMetadata>> {
        var where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = BodyMeasurementsTable.sourceInstanceId,
            fromColumn = BodyMeasurementsTable.measuredAt,
        ).whereOrNull() ?: return emptyLatestResult()
        metricType?.let { where = where and (BodyMeasurementsTable.metricType eq it) }

        val row = BodyMeasurementsTable.selectAll()
            .where(where)
            .orderBy(
                BodyMeasurementsTable.measuredAt to SortOrder.DESC,
                BodyMeasurementsTable.id to SortOrder.DESC,
            )
            .limit(1)
            .map {
                BodyMeasurementRow(
                    id = it[BodyMeasurementsTable.id].value,
                    sourceInstanceId = it[BodyMeasurementsTable.sourceInstanceId],
                    measuredAt = it[BodyMeasurementsTable.measuredAt].toApiString(),
                    metricType = it[BodyMeasurementsTable.metricType],
                    value = it[BodyMeasurementsTable.value],
                    unit = it[BodyMeasurementsTable.unit],
                )
            }
            .singleOrNull()
        return row to sourceMetadata(
            listOfNotNull(row?.sourceInstanceId).toSet(),
            filters.includeSource
        )
    }

    fun listExtendedBodyMeasurements(
        filters: ReadFilters,
        metricType: String?
    ): Pair<List<ExtendedBodyMeasurementRow>, Map<Int, SourceMetadata>> {
        var where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = ExtendedBodyMeasurementsTable.sourceInstanceId,
            fromColumn = ExtendedBodyMeasurementsTable.measuredAt,
        ).whereOrNull() ?: return emptyReadResult()
        metricType?.let { where = where and (ExtendedBodyMeasurementsTable.metricType eq it) }

        val rows = ExtendedBodyMeasurementsTable.selectAll()
            .where(where)
            .orderBy(
                ExtendedBodyMeasurementsTable.measuredAt to filters.sortOrder(),
                ExtendedBodyMeasurementsTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map(::toExtendedBodyMeasurementRow)
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
    }

    fun listExtendedBodyMeasurementsForWindow(
        filters: ReadFilters,
        metricType: String
    ): Pair<List<ExtendedBodyMeasurementRow>, Map<Int, SourceMetadata>> =
        listExtendedBodyMeasurements(filters, metricType)

    fun latestExtendedBodyMeasurementBefore(
        filters: ReadFilters,
        metricType: String
    ): Pair<ExtendedBodyMeasurementRow?, Map<Int, SourceMetadata>> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = ExtendedBodyMeasurementsTable.sourceInstanceId,
            fromColumn = ExtendedBodyMeasurementsTable.measuredAt,
            mode = TimeFilterMode.BEFORE_FROM,
        ).whereOrNull() ?: return emptyLatestResult()

        val row = ExtendedBodyMeasurementsTable.selectAll()
            .where(where and (ExtendedBodyMeasurementsTable.metricType eq metricType))
            .orderBy(
                ExtendedBodyMeasurementsTable.measuredAt to SortOrder.DESC,
                ExtendedBodyMeasurementsTable.id to SortOrder.DESC,
            )
            .limit(1)
            .map(::toExtendedBodyMeasurementRow)
            .singleOrNull()
        return row to sourceMetadata(listOfNotNull(row?.sourceInstanceId).toSet(), filters.includeSource)
    }

    fun latestBodyMeasurementBefore(before: Instant, metricType: String): BodyMeasurementRow? {
        return BodyMeasurementsTable.selectAll()
            .where {
                (BodyMeasurementsTable.measuredAt less before.toDbTimestamp()) and
                        (BodyMeasurementsTable.metricType eq metricType)
            }
            .orderBy(BodyMeasurementsTable.measuredAt to SortOrder.DESC)
            .limit(1)
            .map(::toBodyMeasurementRow)
            .singleOrNull()
    }

    private fun toBodyMeasurementRow(row: ResultRow): BodyMeasurementRow =
        BodyMeasurementRow(
            id = row[BodyMeasurementsTable.id].value,
            sourceInstanceId = row[BodyMeasurementsTable.sourceInstanceId],
            measuredAt = row[BodyMeasurementsTable.measuredAt].toApiString(),
            metricType = row[BodyMeasurementsTable.metricType],
            value = row[BodyMeasurementsTable.value],
            unit = row[BodyMeasurementsTable.unit],
        )

    private fun toExtendedBodyMeasurementRow(row: ResultRow): ExtendedBodyMeasurementRow =
        ExtendedBodyMeasurementRow(
            id = row[ExtendedBodyMeasurementsTable.id].value,
            sourceInstanceId = row[ExtendedBodyMeasurementsTable.sourceInstanceId],
            measuredAt = row[ExtendedBodyMeasurementsTable.measuredAt].toApiString(),
            metricType = row[ExtendedBodyMeasurementsTable.metricType],
            value = row[ExtendedBodyMeasurementsTable.value],
            unit = row[ExtendedBodyMeasurementsTable.unit],
            segment = row[ExtendedBodyMeasurementsTable.segment],
        )

}

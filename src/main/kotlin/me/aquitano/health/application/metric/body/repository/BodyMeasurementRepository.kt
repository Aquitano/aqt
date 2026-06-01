package me.aquitano.health.application.metric.body.repository

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

class BodyMeasurementRepository : BaseMetricRepository() {
    fun listBodyMeasurements(
        filters: ReadFilters,
        metricType: String?
    ): Pair<List<BodyMeasurementRow>, Map<Int, SourceMetadata>> {
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return emptyList<BodyMeasurementRow>() to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(BodyMeasurementsTable.measuredAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(BodyMeasurementsTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(BodyMeasurementsTable.sourceInstanceId inList it) }
        metricType?.let { conditions.add(BodyMeasurementsTable.metricType eq it) }
        val rows = BodyMeasurementsTable.selectAll()
            .where(combineConditions(conditions))
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
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return null to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(BodyMeasurementsTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(BodyMeasurementsTable.sourceInstanceId inList it) }
        conditions.add(BodyMeasurementsTable.metricType eq metricType)
        val row = BodyMeasurementsTable.selectAll()
            .where(combineConditions(conditions))
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
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return emptyList<BodyMeasurementRow>() to emptyMap()
        val latestConditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { latestConditions.add(BodyMeasurementsTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { latestConditions.add(BodyMeasurementsTable.sourceInstanceId inList it) }
        latestConditions.add(BodyMeasurementsTable.metricType eq metricType)
        val latestMeasuredAt = BodyMeasurementsTable.selectAll()
            .where(combineConditions(latestConditions))
            .orderBy(
                BodyMeasurementsTable.measuredAt to SortOrder.DESC,
                BodyMeasurementsTable.id to SortOrder.DESC,
            )
            .limit(1)
            .map { it[BodyMeasurementsTable.measuredAt] }
            .singleOrNull()
            ?: return emptyList<BodyMeasurementRow>() to emptyMap()

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
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return null to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(BodyMeasurementsTable.measuredAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(BodyMeasurementsTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(BodyMeasurementsTable.sourceInstanceId inList it) }
        metricType?.let { conditions.add(BodyMeasurementsTable.metricType eq it) }
        val row = BodyMeasurementsTable.selectAll()
            .where(combineConditions(conditions))
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
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return emptyList<ExtendedBodyMeasurementRow>() to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(ExtendedBodyMeasurementsTable.measuredAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(ExtendedBodyMeasurementsTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(ExtendedBodyMeasurementsTable.sourceInstanceId inList it) }
        metricType?.let { conditions.add(ExtendedBodyMeasurementsTable.metricType eq it) }
        val rows = ExtendedBodyMeasurementsTable.selectAll()
            .where(combineConditions(conditions))
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
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return null to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(ExtendedBodyMeasurementsTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(ExtendedBodyMeasurementsTable.sourceInstanceId inList it) }
        conditions.add(ExtendedBodyMeasurementsTable.metricType eq metricType)
        val row = ExtendedBodyMeasurementsTable.selectAll()
            .where(combineConditions(conditions))
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

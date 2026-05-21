package me.aquitano.health.infrastructure.repositories

import me.aquitano.health.infrastructure.database.tables.*
import me.aquitano.health.infrastructure.database.toApiString
import me.aquitano.health.infrastructure.database.toDbTimestamp
import org.jetbrains.exposed.sql.*
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.SqlExpressionBuilder.greaterEq
import org.jetbrains.exposed.sql.SqlExpressionBuilder.greater
import org.jetbrains.exposed.sql.SqlExpressionBuilder.inList
import org.jetbrains.exposed.sql.SqlExpressionBuilder.less
import org.jetbrains.exposed.sql.SqlExpressionBuilder.lessEq
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

data class SourceMetadata(
    val provider: String,
    val providerInstanceId: String,
)

data class ReadFilters(
    val from: Instant?,
    val to: Instant?,
    val provider: String?,
    val providerInstanceId: String?,
    val includeSource: Boolean,
    val limit: Int,
    val sort: String,
    val order: String,
)

data class DailyReadFilters(
    val fromDate: LocalDate?,
    val toDate: LocalDate?,
    val provider: String?,
    val providerInstanceId: String?,
    val includeSource: Boolean,
    val limit: Int,
    val sort: String,
    val order: String,
)

data class SleepNightReadFilters(
    val fromDate: LocalDate?,
    val toDate: LocalDate?,
    val timezone: ZoneId,
    val provider: String?,
    val providerInstanceId: String?,
    val includeSource: Boolean,
    val limit: Int,
    val sort: String,
    val order: String,
)

data class StepSampleRow(
    val id: Int,
    val sourceInstanceId: Int,
    val startAt: String,
    val endAt: String,
    val steps: Int
)

data class StepDailySummaryRow(
    val sourceInstanceId: Int,
    val date: String,
    val steps: Int,
    val sampleCount: Int
)

data class SleepSessionRow(
    val id: Int,
    val sourceInstanceId: Int,
    val startAt: String,
    val endAt: String,
    val durationSeconds: Long
)

data class SleepNightRow(
    val date: String,
    val timezone: String,
    val session: SleepSessionRow,
)

data class SleepStageRow(
    val stage: String,
    val startAt: String,
    val endAt: String,
    val durationSeconds: Long
)

data class BodyMeasurementRow(
    val id: Int,
    val sourceInstanceId: Int,
    val measuredAt: String,
    val metricType: String,
    val value: Double,
    val unit: String,
)

data class HeartRateSampleRow(
    val id: Int,
    val sourceInstanceId: Int,
    val measuredAt: String,
    val bpm: Int,
    val context: String,
)

data class DashboardStepsSummaryRow(
    val steps: Int,
    val sampleCount: Int,
)

data class HeartRateSummaryRow(
    val count: Int,
    val minBpm: Int?,
    val maxBpm: Int?,
    val avgBpm: Double?,
)

class MetricsReadRepository {
    fun listStepSamples(filters: ReadFilters): Pair<List<StepSampleRow>, Map<Int, SourceMetadata>> {
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return emptyList<StepSampleRow>() to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(StepSamplesTable.startAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(StepSamplesTable.startAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(StepSamplesTable.sourceInstanceId inList it) }
        val rows = StepSamplesTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                StepSamplesTable.startAt to filters.sortOrder(),
                StepSamplesTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map {
                StepSampleRow(
                    id = it[StepSamplesTable.id].value,
                    sourceInstanceId = it[StepSamplesTable.sourceInstanceId],
                    startAt = it[StepSamplesTable.startAt].toApiString(),
                    endAt = it[StepSamplesTable.endAt].toApiString(),
                    steps = it[StepSamplesTable.steps],
                )
            }
        return rows to sourceMetadata(
            rows.map { it.sourceInstanceId }.toSet(),
            filters.includeSource
        )
    }

    fun listStepSamplesForWindow(filters: ReadFilters): Pair<List<StepSampleRow>, Map<Int, SourceMetadata>> {
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return emptyList<StepSampleRow>() to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(StepSamplesTable.endAt greater it.toDbTimestamp()) }
        filters.to?.let { conditions.add(StepSamplesTable.startAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(StepSamplesTable.sourceInstanceId inList it) }
        val rows = StepSamplesTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                StepSamplesTable.startAt to SortOrder.ASC,
                StepSamplesTable.id to SortOrder.ASC,
            )
            .map(::toStepSampleRow)
        return rows to sourceMetadata(
            rows.map { it.sourceInstanceId }.toSet(),
            filters.includeSource
        )
    }

    fun listStepDailySummaries(filters: DailyReadFilters): Pair<List<StepDailySummaryRow>, Map<Int, SourceMetadata>> {
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return emptyList<StepDailySummaryRow>() to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.fromDate?.let { conditions.add(StepDailySummariesTable.date greaterEq it) }
        filters.toDate?.let { conditions.add(StepDailySummariesTable.date lessEq it) }
        sourceIds?.let { conditions.add(StepDailySummariesTable.sourceInstanceId inList it) }
        val rows = StepDailySummariesTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                StepDailySummariesTable.date to filters.sortOrder(),
                StepDailySummariesTable.sourceInstanceId to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map {
                StepDailySummaryRow(
                    sourceInstanceId = it[StepDailySummariesTable.sourceInstanceId],
                    date = it[StepDailySummariesTable.date].toString(),
                    steps = it[StepDailySummariesTable.steps],
                    sampleCount = it[StepDailySummariesTable.sampleCount],
                )
            }
        return rows to sourceMetadata(
            rows.map { it.sourceInstanceId }.toSet(),
            filters.includeSource
        )
    }

    fun listSleepSessions(filters: ReadFilters): Triple<List<SleepSessionRow>, Map<Int, List<SleepStageRow>>, Map<Int, SourceMetadata>> {
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return Triple(
            emptyList(),
            emptyMap(),
            emptyMap()
        )
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(SleepSessionsTable.startAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(SleepSessionsTable.startAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(SleepSessionsTable.sourceInstanceId inList it) }
        val sessions = SleepSessionsTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                SleepSessionsTable.startAt to filters.sortOrder(),
                SleepSessionsTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map {
                SleepSessionRow(
                    id = it[SleepSessionsTable.id].value,
                    sourceInstanceId = it[SleepSessionsTable.sourceInstanceId],
                    startAt = it[SleepSessionsTable.startAt].toApiString(),
                    endAt = it[SleepSessionsTable.endAt].toApiString(),
                    durationSeconds = it[SleepSessionsTable.durationSeconds],
                )
            }
        val stagesBySession = sleepStagesBySession(sessions.map { it.id })
        val metadata = sourceMetadata(
            sessions.map { it.sourceInstanceId }.toSet(),
            filters.includeSource
        )
        return Triple(sessions, stagesBySession, metadata)
    }

    fun listSleepSessionsOverlappingWindow(filters: ReadFilters): Triple<List<SleepSessionRow>, Map<Int, List<SleepStageRow>>, Map<Int, SourceMetadata>> {
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return Triple(
            emptyList(),
            emptyMap(),
            emptyMap()
        )
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(SleepSessionsTable.endAt greater it.toDbTimestamp()) }
        filters.to?.let { conditions.add(SleepSessionsTable.startAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(SleepSessionsTable.sourceInstanceId inList it) }
        val sessions = SleepSessionsTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                SleepSessionsTable.startAt to SortOrder.ASC,
                SleepSessionsTable.id to SortOrder.ASC,
            )
            .map(::toSleepSessionRow)
        val stagesBySession = sleepStagesBySession(sessions.map { it.id })
        val metadata = sourceMetadata(
            sessions.map { it.sourceInstanceId }.toSet(),
            filters.includeSource
        )
        return Triple(sessions, stagesBySession, metadata)
    }

    fun listSleepNights(filters: SleepNightReadFilters): Triple<List<SleepNightRow>, Map<Int, List<SleepStageRow>>, Map<Int, SourceMetadata>> {
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return Triple(
            emptyList(),
            emptyMap(),
            emptyMap()
        )
        val conditions = mutableListOf<Op<Boolean>>()
        filters.fromDate?.let {
            conditions.add(
                SleepSessionsTable.endAt greaterEq it.atStartOfDay(
                    filters.timezone
                ).toInstant().toDbTimestamp()
            )
        }
        filters.toDate?.let {
            conditions.add(
                SleepSessionsTable.endAt less it.plusDays(1)
                    .atStartOfDay(filters.timezone).toInstant().toDbTimestamp()
            )
        }
        sourceIds?.let { conditions.add(SleepSessionsTable.sourceInstanceId inList it) }
        val nights = SleepSessionsTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                SleepSessionsTable.endAt to filters.sortOrder(),
                SleepSessionsTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map {
                val session = SleepSessionRow(
                    id = it[SleepSessionsTable.id].value,
                    sourceInstanceId = it[SleepSessionsTable.sourceInstanceId],
                    startAt = it[SleepSessionsTable.startAt].toApiString(),
                    endAt = it[SleepSessionsTable.endAt].toApiString(),
                    durationSeconds = it[SleepSessionsTable.durationSeconds],
                )
                SleepNightRow(
                    date = Instant.parse(session.endAt).atZone(filters.timezone)
                        .toLocalDate().toString(),
                    timezone = filters.timezone.id,
                    session = session,
                )
            }
        val stagesBySession = sleepStagesBySession(nights.map { it.session.id })
        val metadata = sourceMetadata(
            nights.map { it.session.sourceInstanceId }.toSet(),
            filters.includeSource
        )
        return Triple(nights, stagesBySession, metadata)
    }

    fun latestSleepSession(filters: ReadFilters): Triple<SleepSessionRow?, Map<Int, List<SleepStageRow>>, Map<Int, SourceMetadata>> {
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return Triple(
            null,
            emptyMap(),
            emptyMap()
        )
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(SleepSessionsTable.startAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(SleepSessionsTable.startAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(SleepSessionsTable.sourceInstanceId inList it) }
        val session = SleepSessionsTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                SleepSessionsTable.startAt to SortOrder.DESC,
                SleepSessionsTable.id to SortOrder.DESC,
            )
            .limit(1)
            .map {
                SleepSessionRow(
                    id = it[SleepSessionsTable.id].value,
                    sourceInstanceId = it[SleepSessionsTable.sourceInstanceId],
                    startAt = it[SleepSessionsTable.startAt].toApiString(),
                    endAt = it[SleepSessionsTable.endAt].toApiString(),
                    durationSeconds = it[SleepSessionsTable.durationSeconds],
                )
            }
            .singleOrNull()
        val stagesBySession = sleepStagesBySession(listOfNotNull(session?.id))
        val metadata = sourceMetadata(
            listOfNotNull(session?.sourceInstanceId).toSet(),
            filters.includeSource
        )
        return Triple(session, stagesBySession, metadata)
    }

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

    fun listHeartRateSamples(filters: ReadFilters): Pair<List<HeartRateSampleRow>, Map<Int, SourceMetadata>> {
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return emptyList<HeartRateSampleRow>() to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(HeartRateSamplesTable.measuredAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(HeartRateSamplesTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(HeartRateSamplesTable.sourceInstanceId inList it) }
        val rows = HeartRateSamplesTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                HeartRateSamplesTable.measuredAt to filters.sortOrder(),
                HeartRateSamplesTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map {
                HeartRateSampleRow(
                    id = it[HeartRateSamplesTable.id].value,
                    sourceInstanceId = it[HeartRateSamplesTable.sourceInstanceId],
                    measuredAt = it[HeartRateSamplesTable.measuredAt].toApiString(),
                    bpm = it[HeartRateSamplesTable.bpm],
                    context = it[HeartRateSamplesTable.context] ?: "unknown",
                )
            }
        return rows to sourceMetadata(
            rows.map { it.sourceInstanceId }.toSet(),
            filters.includeSource
        )
    }

    fun listHeartRateSamplesForWindow(filters: ReadFilters): Pair<List<HeartRateSampleRow>, Map<Int, SourceMetadata>> =
        listHeartRateSamples(
            filters.copy(
                limit = Int.MAX_VALUE,
                sort = "measuredAt",
                order = "asc",
            )
        )

    fun latestHeartRateSample(filters: ReadFilters): Pair<HeartRateSampleRow?, Map<Int, SourceMetadata>> {
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return null to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(HeartRateSamplesTable.measuredAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(HeartRateSamplesTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(HeartRateSamplesTable.sourceInstanceId inList it) }
        val row = HeartRateSamplesTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                HeartRateSamplesTable.measuredAt to SortOrder.DESC,
                HeartRateSamplesTable.id to SortOrder.DESC,
            )
            .limit(1)
            .map {
                HeartRateSampleRow(
                    id = it[HeartRateSamplesTable.id].value,
                    sourceInstanceId = it[HeartRateSamplesTable.sourceInstanceId],
                    measuredAt = it[HeartRateSamplesTable.measuredAt].toApiString(),
                    bpm = it[HeartRateSamplesTable.bpm],
                    context = it[HeartRateSamplesTable.context] ?: "unknown",
                )
            }
            .singleOrNull()
        return row to sourceMetadata(
            listOfNotNull(row?.sourceInstanceId).toSet(),
            filters.includeSource
        )
    }

    fun summarizeHeartRate(filters: ReadFilters): HeartRateSummaryRow {
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return HeartRateSummaryRow(
            count = 0,
            minBpm = null,
            maxBpm = null,
            avgBpm = null,
        )
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(HeartRateSamplesTable.measuredAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(HeartRateSamplesTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(HeartRateSamplesTable.sourceInstanceId inList it) }
        val countExpression = HeartRateSamplesTable.id.count()
        val minExpression = HeartRateSamplesTable.bpm.min()
        val maxExpression = HeartRateSamplesTable.bpm.max()
        val avgExpression = HeartRateSamplesTable.bpm.avg()
        return HeartRateSamplesTable
            .select(countExpression, minExpression, maxExpression, avgExpression)
            .where(combineConditions(conditions))
            .single()
            .let {
                HeartRateSummaryRow(
                    count = it[countExpression].toInt(),
                    minBpm = it[minExpression],
                    maxBpm = it[maxExpression],
                    avgBpm = it[avgExpression]?.toDouble(),
                )
            }
    }

    fun summarizeHeartRateForWindow(filters: ReadFilters): HeartRateSummaryRow =
        summarizeHeartRate(filters)

    fun sumStepDailySummaries(filters: DailyReadFilters): DashboardStepsSummaryRow {
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return DashboardStepsSummaryRow(
            steps = 0,
            sampleCount = 0,
        )
        val conditions = mutableListOf<Op<Boolean>>()
        filters.fromDate?.let { conditions.add(StepDailySummariesTable.date greaterEq it) }
        filters.toDate?.let { conditions.add(StepDailySummariesTable.date lessEq it) }
        sourceIds?.let { conditions.add(StepDailySummariesTable.sourceInstanceId inList it) }
        val stepsExpression = StepDailySummariesTable.steps.sum()
        val sampleCountExpression = StepDailySummariesTable.sampleCount.sum()
        val row = StepDailySummariesTable
            .select(stepsExpression, sampleCountExpression)
            .where(combineConditions(conditions))
            .single()
        return DashboardStepsSummaryRow(
            steps = row[stepsExpression] ?: 0,
            sampleCount = row[sampleCountExpression] ?: 0,
        )
    }

    private fun sourceInstanceIds(
        provider: String?,
        providerInstanceId: String?
    ): List<Int>? {
        if (provider == null && providerInstanceId == null) return null
        val join = SourceInstancesTable.innerJoin(SourcesTable)
        val conditions = mutableListOf<Op<Boolean>>()
        provider?.let { conditions.add(SourcesTable.code eq it) }
        providerInstanceId?.let { conditions.add(SourceInstancesTable.providerInstanceId eq it) }
        return join.selectAll()
            .where(combineConditions(conditions))
            .map { it[SourceInstancesTable.id].value }
    }

    private fun sourceMetadata(
        sourceInstanceIds: Set<Int>,
        includeSource: Boolean
    ): Map<Int, SourceMetadata> {
        if (!includeSource || sourceInstanceIds.isEmpty()) return emptyMap()
        return SourceInstancesTable.innerJoin(SourcesTable)
            .selectAll()
            .where { SourceInstancesTable.id inList sourceInstanceIds }
            .associate { row ->
                row[SourceInstancesTable.id].value to SourceMetadata(
                    provider = row[SourcesTable.code],
                    providerInstanceId = row[SourceInstancesTable.providerInstanceId],
                )
            }
    }

    fun sleepStagesBySession(sessionIds: List<Int>): Map<Int, List<SleepStageRow>> {
        if (sessionIds.isEmpty()) return emptyMap()
        return SleepStagesTable.selectAll()
            .where { SleepStagesTable.sleepSessionId inList sessionIds }
            .orderBy(SleepStagesTable.startAt to SortOrder.ASC)
            .groupBy(
                keySelector = { it[SleepStagesTable.sleepSessionId] },
                valueTransform = ::toSleepStageRow,
            )
    }

    private fun toSleepStageRow(row: ResultRow): SleepStageRow =
        SleepStageRow(
            stage = row[SleepStagesTable.stage],
            startAt = row[SleepStagesTable.startAt].toApiString(),
            endAt = row[SleepStagesTable.endAt].toApiString(),
            durationSeconds = row[SleepStagesTable.durationSeconds],
        )

    private fun toStepSampleRow(row: ResultRow): StepSampleRow =
        StepSampleRow(
            id = row[StepSamplesTable.id].value,
            sourceInstanceId = row[StepSamplesTable.sourceInstanceId],
            startAt = row[StepSamplesTable.startAt].toApiString(),
            endAt = row[StepSamplesTable.endAt].toApiString(),
            steps = row[StepSamplesTable.steps],
        )

    private fun toSleepSessionRow(row: ResultRow): SleepSessionRow =
        SleepSessionRow(
            id = row[SleepSessionsTable.id].value,
            sourceInstanceId = row[SleepSessionsTable.sourceInstanceId],
            startAt = row[SleepSessionsTable.startAt].toApiString(),
            endAt = row[SleepSessionsTable.endAt].toApiString(),
            durationSeconds = row[SleepSessionsTable.durationSeconds],
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

    private fun combineConditions(conditions: List<Op<Boolean>>): Op<Boolean> =
        conditions.reduceOrNull { left, right -> left and right } ?: Op.TRUE

    private fun ReadFilters.sortOrder(): SortOrder =
        order.toSortOrder()

    private fun DailyReadFilters.sortOrder(): SortOrder =
        order.toSortOrder()

    private fun SleepNightReadFilters.sortOrder(): SortOrder =
        order.toSortOrder()

    private fun String.toSortOrder(): SortOrder =
        if (equals("desc", ignoreCase = true)) SortOrder.DESC else SortOrder.ASC
}

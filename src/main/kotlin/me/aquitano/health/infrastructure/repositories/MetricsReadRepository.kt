package me.aquitano.health.infrastructure.repositories

import me.aquitano.health.infrastructure.database.tables.*
import org.jetbrains.exposed.sql.*
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.SqlExpressionBuilder.greaterEq
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
)

data class DailyReadFilters(
    val fromDate: LocalDate?,
    val toDate: LocalDate?,
    val provider: String?,
    val providerInstanceId: String?,
    val includeSource: Boolean,
    val limit: Int,
)

data class SleepNightReadFilters(
    val fromDate: LocalDate?,
    val toDate: LocalDate?,
    val timezone: ZoneId,
    val provider: String?,
    val providerInstanceId: String?,
    val includeSource: Boolean,
    val limit: Int,
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

class MetricsReadRepository {
    fun listStepSamples(filters: ReadFilters): Pair<List<StepSampleRow>, Map<Int, SourceMetadata>> {
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return emptyList<StepSampleRow>() to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(StepSamplesTable.startAt greaterEq it.toString()) }
        filters.to?.let { conditions.add(StepSamplesTable.startAt less it.toString()) }
        sourceIds?.let { conditions.add(StepSamplesTable.sourceInstanceId inList it) }
        val rows = StepSamplesTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(StepSamplesTable.startAt to SortOrder.ASC)
            .limit(filters.limit)
            .map {
                StepSampleRow(
                    id = it[StepSamplesTable.id].value,
                    sourceInstanceId = it[StepSamplesTable.sourceInstanceId],
                    startAt = it[StepSamplesTable.startAt],
                    endAt = it[StepSamplesTable.endAt],
                    steps = it[StepSamplesTable.steps],
                )
            }
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
        filters.fromDate?.let { conditions.add(StepDailySummariesTable.date greaterEq it.toString()) }
        filters.toDate?.let { conditions.add(StepDailySummariesTable.date lessEq it.toString()) }
        sourceIds?.let { conditions.add(StepDailySummariesTable.sourceInstanceId inList it) }
        val rows = StepDailySummariesTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(StepDailySummariesTable.date to SortOrder.ASC)
            .limit(filters.limit)
            .map {
                StepDailySummaryRow(
                    sourceInstanceId = it[StepDailySummariesTable.sourceInstanceId],
                    date = it[StepDailySummariesTable.date],
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
        filters.from?.let { conditions.add(SleepSessionsTable.startAt greaterEq it.toString()) }
        filters.to?.let { conditions.add(SleepSessionsTable.startAt less it.toString()) }
        sourceIds?.let { conditions.add(SleepSessionsTable.sourceInstanceId inList it) }
        val sessions = SleepSessionsTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(SleepSessionsTable.startAt to SortOrder.ASC)
            .limit(filters.limit)
            .map {
                SleepSessionRow(
                    id = it[SleepSessionsTable.id].value,
                    sourceInstanceId = it[SleepSessionsTable.sourceInstanceId],
                    startAt = it[SleepSessionsTable.startAt],
                    endAt = it[SleepSessionsTable.endAt],
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
                ).toInstant().toString()
            )
        }
        filters.toDate?.let {
            conditions.add(
                SleepSessionsTable.endAt less it.plusDays(1)
                    .atStartOfDay(filters.timezone).toInstant().toString()
            )
        }
        sourceIds?.let { conditions.add(SleepSessionsTable.sourceInstanceId inList it) }
        val nights = SleepSessionsTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                SleepSessionsTable.endAt to SortOrder.ASC,
                SleepSessionsTable.id to SortOrder.ASC,
            )
            .limit(filters.limit)
            .map {
                val session = SleepSessionRow(
                    id = it[SleepSessionsTable.id].value,
                    sourceInstanceId = it[SleepSessionsTable.sourceInstanceId],
                    startAt = it[SleepSessionsTable.startAt],
                    endAt = it[SleepSessionsTable.endAt],
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
        filters.from?.let { conditions.add(SleepSessionsTable.startAt greaterEq it.toString()) }
        filters.to?.let { conditions.add(SleepSessionsTable.startAt less it.toString()) }
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
                    startAt = it[SleepSessionsTable.startAt],
                    endAt = it[SleepSessionsTable.endAt],
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
        filters.from?.let { conditions.add(BodyMeasurementsTable.measuredAt greaterEq it.toString()) }
        filters.to?.let { conditions.add(BodyMeasurementsTable.measuredAt less it.toString()) }
        sourceIds?.let { conditions.add(BodyMeasurementsTable.sourceInstanceId inList it) }
        metricType?.let { conditions.add(BodyMeasurementsTable.metricType eq it) }
        val rows = BodyMeasurementsTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(BodyMeasurementsTable.measuredAt to SortOrder.ASC)
            .limit(filters.limit)
            .map {
                BodyMeasurementRow(
                    id = it[BodyMeasurementsTable.id].value,
                    sourceInstanceId = it[BodyMeasurementsTable.sourceInstanceId],
                    measuredAt = it[BodyMeasurementsTable.measuredAt],
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

    fun latestBodyMeasurement(
        filters: ReadFilters,
        metricType: String?
    ): Pair<BodyMeasurementRow?, Map<Int, SourceMetadata>> {
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return null to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(BodyMeasurementsTable.measuredAt greaterEq it.toString()) }
        filters.to?.let { conditions.add(BodyMeasurementsTable.measuredAt less it.toString()) }
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
                    measuredAt = it[BodyMeasurementsTable.measuredAt],
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
        filters.from?.let { conditions.add(HeartRateSamplesTable.measuredAt greaterEq it.toString()) }
        filters.to?.let { conditions.add(HeartRateSamplesTable.measuredAt less it.toString()) }
        sourceIds?.let { conditions.add(HeartRateSamplesTable.sourceInstanceId inList it) }
        val rows = HeartRateSamplesTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(HeartRateSamplesTable.measuredAt to SortOrder.ASC)
            .limit(filters.limit)
            .map {
                HeartRateSampleRow(
                    id = it[HeartRateSamplesTable.id].value,
                    sourceInstanceId = it[HeartRateSamplesTable.sourceInstanceId],
                    measuredAt = it[HeartRateSamplesTable.measuredAt],
                    bpm = it[HeartRateSamplesTable.bpm],
                    context = it[HeartRateSamplesTable.context] ?: "unknown",
                )
            }
        return rows to sourceMetadata(
            rows.map { it.sourceInstanceId }.toSet(),
            filters.includeSource
        )
    }

    fun latestHeartRateSample(filters: ReadFilters): Pair<HeartRateSampleRow?, Map<Int, SourceMetadata>> {
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return null to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(HeartRateSamplesTable.measuredAt greaterEq it.toString()) }
        filters.to?.let { conditions.add(HeartRateSamplesTable.measuredAt less it.toString()) }
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
                    measuredAt = it[HeartRateSamplesTable.measuredAt],
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

    fun sumStepDailySummaries(filters: DailyReadFilters): DashboardStepsSummaryRow {
        val sourceIds =
            sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return DashboardStepsSummaryRow(
            steps = 0,
            sampleCount = 0,
        )
        val conditions = mutableListOf<Op<Boolean>>()
        filters.fromDate?.let { conditions.add(StepDailySummariesTable.date greaterEq it.toString()) }
        filters.toDate?.let { conditions.add(StepDailySummariesTable.date lessEq it.toString()) }
        sourceIds?.let { conditions.add(StepDailySummariesTable.sourceInstanceId inList it) }
        var steps = 0
        var sampleCount = 0
        StepDailySummariesTable.selectAll()
            .where(combineConditions(conditions))
            .forEach {
                steps += it[StepDailySummariesTable.steps]
                sampleCount += it[StepDailySummariesTable.sampleCount]
            }
        return DashboardStepsSummaryRow(
            steps = steps,
            sampleCount = sampleCount,
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

    private fun sleepStagesBySession(sessionIds: List<Int>): Map<Int, List<SleepStageRow>> {
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
            startAt = row[SleepStagesTable.startAt],
            endAt = row[SleepStagesTable.endAt],
            durationSeconds = row[SleepStagesTable.durationSeconds],
        )

    private fun combineConditions(conditions: List<Op<Boolean>>): Op<Boolean> =
        conditions.reduceOrNull { left, right -> left and right } ?: Op.TRUE
}

package me.aquitano.health.infrastructure.repositories

import me.aquitano.health.application.metric.common.MetricReadRepository

import me.aquitano.health.infrastructure.database.tables.*
import me.aquitano.health.infrastructure.database.toApiString
import me.aquitano.health.infrastructure.database.toDbTimestamp
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.greater
import org.jetbrains.exposed.v1.core.greaterEq
import org.jetbrains.exposed.v1.core.inList
import org.jetbrains.exposed.v1.core.less
import org.jetbrains.exposed.v1.core.lessEq
import org.jetbrains.exposed.v1.jdbc.*
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

data class ActivitySummaryRow(
    val id: Int,
    val sourceInstanceId: Int,
    val date: String,
    val distanceMeters: Double?,
    val activeEnergyKcal: Double?,
    val totalEnergyKcal: Double?,
    val elevationMeters: Double?,
    val softMinutes: Int?,
    val moderateMinutes: Int?,
    val intenseMinutes: Int?,
    val activeMinutes: Int?,
    val averageHeartRateBpm: Int?,
    val minHeartRateBpm: Int?,
    val maxHeartRateBpm: Int?,
)

data class SleepSummaryRow(
    val id: Int,
    val sourceInstanceId: Int,
    val startAt: String,
    val endAt: String,
    val timeInBedSeconds: Long?,
    val totalSleepSeconds: Long?,
    val lightSleepSeconds: Long?,
    val deepSleepSeconds: Long?,
    val remSleepSeconds: Long?,
    val sleepEfficiencyPercent: Double?,
    val sleepLatencySeconds: Long?,
    val wakeupLatencySeconds: Long?,
    val wakeupDurationSeconds: Long?,
    val wakeupCount: Int?,
    val wasoSeconds: Long?,
    val sleepScore: Int?,
    val remEpisodesCount: Int?,
    val outOfBedCount: Int?,
    val awakeDurationSeconds: Long?,
    val overnightHrvRmssd: Double?,
    val respiratoryRhythm: Double?,
    val breathingQuality: Int?,
    val snoringDurationSeconds: Long?,
    val apneaHypopneaIndex: Double?,
    val movementScore: Double?,
    val snoringEpisodeCount: Int?,
    val hrAverageBpm: Int?,
    val hrMinBpm: Int?,
    val hrMaxBpm: Int?,
    val rrAverage: Double?,
    val rrMin: Double?,
    val rrMax: Double?,
)

data class HeartRateSampleRow(
    val id: Int,
    val sourceInstanceId: Int,
    val measuredAt: String,
    val bpm: Int,
    val context: String,
)

data class RespiratoryRateSampleRow(
    val id: Int,
    val sourceInstanceId: Int,
    val measuredAt: String,
    val breathsPerMinute: Int,
    val context: String,
)

data class BloodPressureMeasurementRow(
    val id: Int,
    val sourceInstanceId: Int,
    val measuredAt: String,
    val systolicMmhg: Int,
    val diastolicMmhg: Int,
    val heartRateBpm: Int?,
)

data class CardiovascularMeasurementRow(
    val id: Int,
    val sourceInstanceId: Int,
    val measuredAt: String,
    val metricType: String,
    val value: Double,
    val unit: String,
)

data class ExtendedBodyMeasurementRow(
    val id: Int,
    val sourceInstanceId: Int,
    val measuredAt: String,
    val metricType: String,
    val value: Double,
    val unit: String,
    val segment: String?,
)

data class HrvSampleRow(
    val id: Int,
    val sourceInstanceId: Int,
    val measuredAt: String,
    val metricType: String,
    val value: Double,
    val unit: String,
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

data class RespiratoryRateSummaryRow(
    val count: Int,
    val minBreathsPerMinute: Int?,
    val maxBreathsPerMinute: Int?,
    val avgBreathsPerMinute: Double?,
)

data class HrvSummaryRow(
    val count: Int,
    val minValue: Double?,
    val maxValue: Double?,
    val avgValue: Double?,
)

class MetricsReadRepository : MetricReadRepository {
    fun listActivitySummaries(filters: DailyReadFilters): Pair<List<ActivitySummaryRow>, Map<Int, SourceMetadata>> {
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return emptyList<ActivitySummaryRow>() to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.fromDate?.let { conditions.add(ActivitySummariesTable.date greaterEq it) }
        filters.toDate?.let { conditions.add(ActivitySummariesTable.date lessEq it) }
        sourceIds?.let { conditions.add(ActivitySummariesTable.sourceInstanceId inList it) }
        val rows = ActivitySummariesTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                ActivitySummariesTable.date to filters.sortOrder(),
                ActivitySummariesTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map(::toActivitySummaryRow)
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
    }

    fun latestActivitySummary(filters: DailyReadFilters): Pair<ActivitySummaryRow?, Map<Int, SourceMetadata>> {
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return null to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.fromDate?.let { conditions.add(ActivitySummariesTable.date greaterEq it) }
        filters.toDate?.let { conditions.add(ActivitySummariesTable.date lessEq it) }
        sourceIds?.let { conditions.add(ActivitySummariesTable.sourceInstanceId inList it) }
        val row = ActivitySummariesTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                ActivitySummariesTable.date to SortOrder.DESC,
                ActivitySummariesTable.id to SortOrder.DESC,
            )
            .limit(1)
            .map(::toActivitySummaryRow)
            .singleOrNull()
        return row to sourceMetadata(listOfNotNull(row?.sourceInstanceId).toSet(), filters.includeSource)
    }

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

    fun listSleepSummaries(filters: ReadFilters): Pair<List<SleepSummaryRow>, Map<Int, SourceMetadata>> {
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return emptyList<SleepSummaryRow>() to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(SleepSummariesTable.startAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(SleepSummariesTable.startAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(SleepSummariesTable.sourceInstanceId inList it) }
        val rows = SleepSummariesTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                SleepSummariesTable.endAt to filters.sortOrder(),
                SleepSummariesTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map(::toSleepSummaryRow)
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
    }

    fun latestSleepSummary(filters: ReadFilters): Pair<SleepSummaryRow?, Map<Int, SourceMetadata>> {
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return null to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(SleepSummariesTable.startAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(SleepSummariesTable.startAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(SleepSummariesTable.sourceInstanceId inList it) }
        val row = SleepSummariesTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                SleepSummariesTable.endAt to SortOrder.DESC,
                SleepSummariesTable.id to SortOrder.DESC,
            )
            .limit(1)
            .map(::toSleepSummaryRow)
            .singleOrNull()
        return row to sourceMetadata(listOfNotNull(row?.sourceInstanceId).toSet(), filters.includeSource)
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

    fun listRespiratoryRateSamples(filters: ReadFilters): Pair<List<RespiratoryRateSampleRow>, Map<Int, SourceMetadata>> {
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return emptyList<RespiratoryRateSampleRow>() to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(RespiratoryRateSamplesTable.measuredAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(RespiratoryRateSamplesTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(RespiratoryRateSamplesTable.sourceInstanceId inList it) }
        val rows = RespiratoryRateSamplesTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                RespiratoryRateSamplesTable.measuredAt to filters.sortOrder(),
                RespiratoryRateSamplesTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map(::toRespiratoryRateSampleRow)
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
    }

    fun latestRespiratoryRateSample(filters: ReadFilters): Pair<RespiratoryRateSampleRow?, Map<Int, SourceMetadata>> {
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return null to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(RespiratoryRateSamplesTable.measuredAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(RespiratoryRateSamplesTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(RespiratoryRateSamplesTable.sourceInstanceId inList it) }
        val row = RespiratoryRateSamplesTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                RespiratoryRateSamplesTable.measuredAt to SortOrder.DESC,
                RespiratoryRateSamplesTable.id to SortOrder.DESC,
            )
            .limit(1)
            .map(::toRespiratoryRateSampleRow)
            .singleOrNull()
        return row to sourceMetadata(listOfNotNull(row?.sourceInstanceId).toSet(), filters.includeSource)
    }

    fun summarizeRespiratoryRate(filters: ReadFilters): RespiratoryRateSummaryRow {
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return RespiratoryRateSummaryRow(0, null, null, null)
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(RespiratoryRateSamplesTable.measuredAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(RespiratoryRateSamplesTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(RespiratoryRateSamplesTable.sourceInstanceId inList it) }
        val countExpression = RespiratoryRateSamplesTable.id.count()
        val minExpression = RespiratoryRateSamplesTable.breathsPerMinute.min()
        val maxExpression = RespiratoryRateSamplesTable.breathsPerMinute.max()
        val avgExpression = RespiratoryRateSamplesTable.breathsPerMinute.avg()
        return RespiratoryRateSamplesTable
            .select(countExpression, minExpression, maxExpression, avgExpression)
            .where(combineConditions(conditions))
            .single()
            .let {
                RespiratoryRateSummaryRow(
                    count = it[countExpression].toInt(),
                    minBreathsPerMinute = it[minExpression],
                    maxBreathsPerMinute = it[maxExpression],
                    avgBreathsPerMinute = it[avgExpression]?.toDouble(),
                )
            }
    }

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

    fun listBloodPressure(filters: ReadFilters): Pair<List<BloodPressureMeasurementRow>, Map<Int, SourceMetadata>> {
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return emptyList<BloodPressureMeasurementRow>() to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(BloodPressureMeasurementsTable.measuredAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(BloodPressureMeasurementsTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(BloodPressureMeasurementsTable.sourceInstanceId inList it) }
        val rows = BloodPressureMeasurementsTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                BloodPressureMeasurementsTable.measuredAt to filters.sortOrder(),
                BloodPressureMeasurementsTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map(::toBloodPressureMeasurementRow)
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
    }

    fun latestBloodPressure(filters: ReadFilters): Pair<BloodPressureMeasurementRow?, Map<Int, SourceMetadata>> {
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return null to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(BloodPressureMeasurementsTable.measuredAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(BloodPressureMeasurementsTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(BloodPressureMeasurementsTable.sourceInstanceId inList it) }
        val row = BloodPressureMeasurementsTable.selectAll()
            .where(combineConditions(conditions))
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
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return emptyList<CardiovascularMeasurementRow>() to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(CardiovascularMeasurementsTable.measuredAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(CardiovascularMeasurementsTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(CardiovascularMeasurementsTable.sourceInstanceId inList it) }
        metricType?.let { conditions.add(CardiovascularMeasurementsTable.metricType eq it) }
        val rows = CardiovascularMeasurementsTable.selectAll()
            .where(combineConditions(conditions))
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
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return null to emptyMap()
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(CardiovascularMeasurementsTable.measuredAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(CardiovascularMeasurementsTable.measuredAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(CardiovascularMeasurementsTable.sourceInstanceId inList it) }
        conditions.add(CardiovascularMeasurementsTable.metricType eq metricType)
        val row = CardiovascularMeasurementsTable.selectAll()
            .where(combineConditions(conditions))
            .orderBy(
                CardiovascularMeasurementsTable.measuredAt to SortOrder.DESC,
                CardiovascularMeasurementsTable.id to SortOrder.DESC,
            )
            .limit(1)
            .map(::toCardiovascularMeasurementRow)
            .singleOrNull()
        return row to sourceMetadata(listOfNotNull(row?.sourceInstanceId).toSet(), filters.includeSource)
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

    fun sourceMetadataFor(sourceInstanceIds: Set<Int>): Map<Int, SourceMetadata> =
        sourceMetadata(sourceInstanceIds, includeSource = true)

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

    private fun toActivitySummaryRow(row: ResultRow): ActivitySummaryRow =
        ActivitySummaryRow(
            id = row[ActivitySummariesTable.id].value,
            sourceInstanceId = row[ActivitySummariesTable.sourceInstanceId],
            date = row[ActivitySummariesTable.date].toString(),
            distanceMeters = row[ActivitySummariesTable.distanceMeters],
            activeEnergyKcal = row[ActivitySummariesTable.activeEnergyKcal],
            totalEnergyKcal = row[ActivitySummariesTable.totalEnergyKcal],
            elevationMeters = row[ActivitySummariesTable.elevationMeters],
            softMinutes = row[ActivitySummariesTable.softMinutes],
            moderateMinutes = row[ActivitySummariesTable.moderateMinutes],
            intenseMinutes = row[ActivitySummariesTable.intenseMinutes],
            activeMinutes = row[ActivitySummariesTable.activeMinutes],
            averageHeartRateBpm = row[ActivitySummariesTable.avgHeartRateBpm],
            minHeartRateBpm = row[ActivitySummariesTable.minHeartRateBpm],
            maxHeartRateBpm = row[ActivitySummariesTable.maxHeartRateBpm],
        )

    private fun toSleepSummaryRow(row: ResultRow): SleepSummaryRow =
        SleepSummaryRow(
            id = row[SleepSummariesTable.id].value,
            sourceInstanceId = row[SleepSummariesTable.sourceInstanceId],
            startAt = row[SleepSummariesTable.startAt].toApiString(),
            endAt = row[SleepSummariesTable.endAt].toApiString(),
            timeInBedSeconds = row[SleepSummariesTable.timeInBedSeconds],
            totalSleepSeconds = row[SleepSummariesTable.totalSleepSeconds],
            lightSleepSeconds = row[SleepSummariesTable.lightSleepSeconds],
            deepSleepSeconds = row[SleepSummariesTable.deepSleepSeconds],
            remSleepSeconds = row[SleepSummariesTable.remSleepSeconds],
            sleepEfficiencyPercent = row[SleepSummariesTable.sleepEfficiencyPercent],
            sleepLatencySeconds = row[SleepSummariesTable.sleepLatencySeconds],
            wakeupLatencySeconds = row[SleepSummariesTable.wakeupLatencySeconds],
            wakeupDurationSeconds = row[SleepSummariesTable.wakeupDurationSeconds],
            wakeupCount = row[SleepSummariesTable.wakeupCount],
            wasoSeconds = row[SleepSummariesTable.wasoSeconds],
            sleepScore = row[SleepSummariesTable.sleepScore],
            remEpisodesCount = row[SleepSummariesTable.remEpisodesCount],
            outOfBedCount = row[SleepSummariesTable.outOfBedCount],
            awakeDurationSeconds = row[SleepSummariesTable.awakeDurationSeconds],
            overnightHrvRmssd = row[SleepSummariesTable.overnightHrvRmssd],
            respiratoryRhythm = row[SleepSummariesTable.respiratoryRhythm],
            breathingQuality = row[SleepSummariesTable.breathingQuality],
            snoringDurationSeconds = row[SleepSummariesTable.snoringDurationSeconds],
            apneaHypopneaIndex = row[SleepSummariesTable.apneaHypopneaIndex],
            movementScore = row[SleepSummariesTable.movementScore],
            snoringEpisodeCount = row[SleepSummariesTable.snoringEpisodeCount],
            hrAverageBpm = row[SleepSummariesTable.hrAverageBpm],
            hrMinBpm = row[SleepSummariesTable.hrMinBpm],
            hrMaxBpm = row[SleepSummariesTable.hrMaxBpm],
            rrAverage = row[SleepSummariesTable.rrAverage],
            rrMin = row[SleepSummariesTable.rrMin],
            rrMax = row[SleepSummariesTable.rrMax],
        )

    private fun toRespiratoryRateSampleRow(row: ResultRow): RespiratoryRateSampleRow =
        RespiratoryRateSampleRow(
            id = row[RespiratoryRateSamplesTable.id].value,
            sourceInstanceId = row[RespiratoryRateSamplesTable.sourceInstanceId],
            measuredAt = row[RespiratoryRateSamplesTable.measuredAt].toApiString(),
            breathsPerMinute = row[RespiratoryRateSamplesTable.breathsPerMinute],
            context = row[RespiratoryRateSamplesTable.context] ?: "unknown",
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
    fun avgSleepDuration(filters: ReadFilters): Long? {
        val sourceIds = sourceInstanceIds(filters.provider, filters.providerInstanceId)
        if (sourceIds != null && sourceIds.isEmpty()) return null
        val conditions = mutableListOf<Op<Boolean>>()
        filters.from?.let { conditions.add(SleepSessionsTable.endAt greaterEq it.toDbTimestamp()) }
        filters.to?.let { conditions.add(SleepSessionsTable.startAt less it.toDbTimestamp()) }
        sourceIds?.let { conditions.add(SleepSessionsTable.sourceInstanceId inList it) }
        val avgExpression = SleepSessionsTable.durationSeconds.avg()
        return SleepSessionsTable
            .select(avgExpression)
            .where(combineConditions(conditions))
            .singleOrNull()
            ?.let { it[avgExpression]?.toLong() }
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
}
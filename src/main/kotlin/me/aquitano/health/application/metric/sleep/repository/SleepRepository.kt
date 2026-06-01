package me.aquitano.health.application.metric.sleep.repository

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
import java.time.ZoneId

class SleepRepository : BaseMetricRepository() {
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

    private fun toSleepStageRow(row: ResultRow): SleepStageRow =
        SleepStageRow(
            stage = row[SleepStagesTable.stage],
            startAt = row[SleepStagesTable.startAt].toApiString(),
            endAt = row[SleepStagesTable.endAt].toApiString(),
            durationSeconds = row[SleepStagesTable.durationSeconds],
        )

    private fun toSleepSessionRow(row: ResultRow): SleepSessionRow =
        SleepSessionRow(
            id = row[SleepSessionsTable.id].value,
            sourceInstanceId = row[SleepSessionsTable.sourceInstanceId],
            startAt = row[SleepSessionsTable.startAt].toApiString(),
            endAt = row[SleepSessionsTable.endAt].toApiString(),
            durationSeconds = row[SleepSessionsTable.durationSeconds],
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
}

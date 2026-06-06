package me.aquitano.health.application.metric.sleep.repository

import me.aquitano.health.application.metric.common.repository.ReadFilters
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.infrastructure.database.tables.CanonicalSleepSessionsTable
import me.aquitano.health.infrastructure.database.tables.SleepSessionsTable
import me.aquitano.health.infrastructure.database.tables.SleepStagesTable
import me.aquitano.health.infrastructure.database.toApiString
import me.aquitano.health.infrastructure.database.toDbTimestamp
import me.aquitano.health.infrastructure.repositories.common.BaseMetricRepository
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.jdbc.batchInsert
import org.jetbrains.exposed.v1.jdbc.deleteWhere
import org.jetbrains.exposed.v1.jdbc.selectAll
import java.time.Instant
import java.time.LocalDate

data class CanonicalSleepSessionRowOutput(
    val sleepSessionId: Int,
    val sourceInstanceId: Int,
    val startAt: Instant,
    val endAt: Instant,
)

data class CanonicalSleepSessionOutput(
    val date: LocalDate,
    val algorithmVersion: Int,
    val computedAt: Instant,
    val sessions: List<CanonicalSleepSessionRowOutput>,
)

class CanonicalSleepSessionDerivationRepository : BaseMetricRepository() {
    fun listRawSessionsForDay(dayStart: Instant, dayEnd: Instant): List<SleepSessionRow> =
        SleepSessionsTable.selectAll()
            .where {
                (SleepSessionsTable.startAt greaterEq dayStart.toDbTimestamp()) and
                    (SleepSessionsTable.startAt less dayEnd.toDbTimestamp())
            }
            .orderBy(SleepSessionsTable.startAt to SortOrder.ASC, SleepSessionsTable.id to SortOrder.ASC)
            .map(::toSleepSessionRow)

    fun listRawStagesForSessions(sessionIds: Set<Int>): Map<Int, List<SleepStageRow>> {
        if (sessionIds.isEmpty()) return emptyMap()
        return SleepStagesTable.selectAll()
            .where { SleepStagesTable.sleepSessionId inList sessionIds }
            .map {
                it[SleepStagesTable.sleepSessionId] to SleepStageRow(
                    stage = it[SleepStagesTable.stage],
                    startAt = it[SleepStagesTable.startAt].toApiString(),
                    endAt = it[SleepStagesTable.endAt].toApiString(),
                    durationSeconds = it[SleepStagesTable.durationSeconds],
                )
            }
            .groupBy({ it.first }, { it.second })
    }

    fun persistCanonicalOutput(output: CanonicalSleepSessionOutput): Int {
        CanonicalSleepSessionsTable.deleteWhere {
            (CanonicalSleepSessionsTable.date eq output.date) and
                (CanonicalSleepSessionsTable.algorithmVersion eq output.algorithmVersion)
        }
        if (output.sessions.isEmpty()) {
            return 0
        }
        CanonicalSleepSessionsTable.batchInsert(output.sessions) { session ->
            this[CanonicalSleepSessionsTable.date] = output.date
            this[CanonicalSleepSessionsTable.sourceInstanceId] = session.sourceInstanceId
            this[CanonicalSleepSessionsTable.sleepSessionId] = session.sleepSessionId
            this[CanonicalSleepSessionsTable.startAt] = session.startAt.toDbTimestamp()
            this[CanonicalSleepSessionsTable.endAt] = session.endAt.toDbTimestamp()
            this[CanonicalSleepSessionsTable.algorithmVersion] = output.algorithmVersion
            this[CanonicalSleepSessionsTable.computedAt] = output.computedAt.toDbTimestamp()
        }
        return output.sessions.size
    }

    fun listCanonicalSleepSessions(
        filters: ReadFilters,
        algorithmVersion: Int,
    ): Pair<List<SleepSessionRow>, Map<Int, SourceMetadata>> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = CanonicalSleepSessionsTable.sourceInstanceId,
            fromColumn = CanonicalSleepSessionsTable.startAt,
        ).whereOrNull() ?: return emptyReadResult()

        val rows = CanonicalSleepSessionsTable
            .innerJoin(SleepSessionsTable, { sleepSessionId }, { SleepSessionsTable.id })
            .selectAll()
            .where(where and (CanonicalSleepSessionsTable.algorithmVersion eq algorithmVersion))
            .orderBy(
                CanonicalSleepSessionsTable.endAt to filters.sortOrder(),
                SleepSessionsTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map(::toJoinedSleepSessionRow)
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
    }

    private fun toJoinedSleepSessionRow(row: ResultRow): SleepSessionRow =
        toSleepSessionRow(row)

    private fun toSleepSessionRow(row: ResultRow): SleepSessionRow =
        SleepSessionRow(
            id = row[SleepSessionsTable.id].value,
            sourceInstanceId = row[SleepSessionsTable.sourceInstanceId],
            startAt = row[SleepSessionsTable.startAt].toApiString(),
            endAt = row[SleepSessionsTable.endAt].toApiString(),
            durationSeconds = row[SleepSessionsTable.durationSeconds],
        )
}

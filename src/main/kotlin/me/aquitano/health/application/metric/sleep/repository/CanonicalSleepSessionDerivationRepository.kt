package me.aquitano.health.application.metric.sleep.repository

import me.aquitano.health.application.metric.common.repository.ReadFilters
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.infrastructure.database.tables.CanonicalSleepSessionsTable
import me.aquitano.health.infrastructure.database.tables.SleepSessionsTable
import me.aquitano.health.infrastructure.database.tables.SleepStagesTable
import me.aquitano.health.infrastructure.database.toApiString
import me.aquitano.health.infrastructure.repositories.common.BaseMetricRepository
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.jdbc.selectAll

/** Reads through the canonical_sleep_sessions view (winning provider per UTC date keeps all sessions, see V15). */
class CanonicalSleepSessionDerivationRepository : BaseMetricRepository() {
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

    fun listCanonicalSleepSessions(
        filters: ReadFilters,
    ): Pair<List<SleepSessionRow>, Map<Int, SourceMetadata>> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = CanonicalSleepSessionsTable.sourceInstanceId,
            fromColumn = CanonicalSleepSessionsTable.startAt,
        ).whereOrNull() ?: return emptyReadResult()

        val keyset = timestampKeyset(
            filters.cursor,
            filters.order,
            CanonicalSleepSessionsTable.endAt,
            SleepSessionsTable.id,
        )
        val rows = CanonicalSleepSessionsTable
            .innerJoin(SleepSessionsTable, { sleepSessionId }, { SleepSessionsTable.id })
            .selectAll()
            .where(keyset?.let { where and it } ?: where)
            .orderBy(
                CanonicalSleepSessionsTable.endAt to filters.sortOrder(),
                SleepSessionsTable.id to filters.sortOrder(),
            )
            .limit(filters.limit + 1)
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

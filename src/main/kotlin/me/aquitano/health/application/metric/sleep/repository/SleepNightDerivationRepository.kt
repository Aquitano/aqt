package me.aquitano.health.application.metric.sleep.repository

import me.aquitano.health.application.metric.sleep.derived.SleepNightOutput
import me.aquitano.health.application.metric.sleep.derived.SleepNightRawSession
import me.aquitano.health.infrastructure.database.tables.CanonicalSleepNightsTable
import me.aquitano.health.infrastructure.database.tables.SleepStagesTable
import me.aquitano.health.infrastructure.database.tables.SleepNightsTable
import me.aquitano.health.infrastructure.database.tables.SleepSessionsTable
import me.aquitano.health.infrastructure.database.tables.SourceInstancesTable
import me.aquitano.health.infrastructure.database.tables.SourcesTable
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.infrastructure.database.toApiString
import me.aquitano.health.infrastructure.database.toDbTimestamp
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.jdbc.deleteWhere
import org.jetbrains.exposed.v1.jdbc.select
import org.jetbrains.exposed.v1.jdbc.selectAll
import org.jetbrains.exposed.v1.jdbc.upsert
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

data class SleepNightRecord(
    val sleepSessionId: Int,
    val sourceInstanceId: Int,
    val date: LocalDate,
    val algorithmVersion: Int,
    val computedAt: Instant,
)

class SleepNightDerivationRepository {
    fun sourceInstanceIds(
        provider: String?,
        providerInstanceId: String?,
    ): Set<Int>? {
        if (provider == null && providerInstanceId == null) return null
        return SourceInstancesTable
            .innerJoin(SourcesTable)
            .select(SourceInstancesTable.id)
            .where {
                val conditions = mutableListOf<Op<Boolean>>()
                provider?.let { conditions.add(SourcesTable.code eq it) }
                providerInstanceId?.let {
                    conditions.add(SourceInstancesTable.providerInstanceId eq it)
                }
                conditions.reduceOrNull { left, right -> left and right } ?: Op.TRUE
            }
            .map { it[SourceInstancesTable.id].value }
            .toSet()
    }

    fun listSleepSessionsEndingInWindow(
        sourceInstanceIds: Set<Int>?,
        windowStart: Instant,
        windowEnd: Instant,
    ): List<SleepNightRawSession> {
        if (sourceInstanceIds != null && sourceInstanceIds.isEmpty()) return emptyList()

        val conditions = mutableListOf<Op<Boolean>>(
            SleepSessionsTable.endAt greaterEq windowStart.toDbTimestamp(),
            SleepSessionsTable.endAt less windowEnd.toDbTimestamp(),
        )
        sourceInstanceIds?.let {
            conditions.add(SleepSessionsTable.sourceInstanceId inList it)
        }

        return SleepSessionsTable
            .selectAll()
            .where { conditions.reduce { left, right -> left and right } }
            .map {
                SleepNightRawSession(
                    id = it[SleepSessionsTable.id].value,
                    sourceInstanceId = it[SleepSessionsTable.sourceInstanceId],
                    endAt = it[SleepSessionsTable.endAt].toInstant(),
                )
            }
    }

    fun findDatesNeedingRecompute(
        sourceInstanceIds: Set<Int>?,
        dates: Set<LocalDate>,
        timezone: java.time.ZoneId,
        algorithmVersion: Int,
    ): Set<LocalDate> {
        if (dates.isEmpty()) return emptySet()
        if (sourceInstanceIds != null && sourceInstanceIds.isEmpty()) return emptySet()

        val minDate = dates.minOrNull() ?: return emptySet()
        val maxDate = dates.maxOrNull() ?: return emptySet()

        val windowStart = minDate.atStartOfDay(timezone).toInstant()
        val windowEnd = maxDate.plusDays(1).atStartOfDay(timezone).toInstant()

        val sessions = listSleepSessionsEndingInWindow(sourceInstanceIds, windowStart, windowEnd)
        val sessionsByDate = sessions.groupBy { it.endAt.atZone(timezone).toLocalDate() }

        val storedNights = listSleepNightsForTimezoneAndDates(sourceInstanceIds, timezone.id, dates)
        val storedNightsByDate = storedNights.groupBy { it.date }

        return dates.filter { date ->
            val dateSessions = sessionsByDate[date] ?: emptyList()
            val dateNights = storedNightsByDate[date] ?: emptyList()

            val sessionsBySource = dateSessions.groupBy { it.sourceInstanceId }
            val nightsBySource = dateNights.groupBy { it.sourceInstanceId }

            val allSourceIds = sessionsBySource.keys + nightsBySource.keys
            allSourceIds.any { sourceId ->
                val sourceSessions = sessionsBySource[sourceId]?.map { it.id }?.toSet() ?: emptySet()
                val sourceNightsList = nightsBySource[sourceId] ?: emptyList()

                val hasWrongVersion = sourceNightsList.any { it.algorithmVersion != algorithmVersion }
                if (hasWrongVersion) return@any true

                val sourceNights = sourceNightsList.map { it.sleepSessionId }.toSet()
                sourceSessions != sourceNights
            }
        }.toSet()
    }

    private fun listSleepNightsForTimezoneAndDates(
        sourceInstanceIds: Set<Int>?,
        timezone: String,
        dates: Set<LocalDate>,
    ): List<SleepNightRecord> {
        if (sourceInstanceIds != null && sourceInstanceIds.isEmpty()) return emptyList()
        if (dates.isEmpty()) return emptyList()

        val conditions = mutableListOf<Op<Boolean>>(
            SleepNightsTable.timezone eq timezone,
            SleepNightsTable.date inList dates,
        )
        sourceInstanceIds?.let {
            conditions.add(SleepNightsTable.sourceInstanceId inList it)
        }

        return SleepNightsTable
            .selectAll()
            .where { conditions.reduce { left, right -> left and right } }
            .map {
                SleepNightRecord(
                    sleepSessionId = it[SleepNightsTable.sleepSessionId],
                    sourceInstanceId = it[SleepNightsTable.sourceInstanceId],
                    date = it[SleepNightsTable.date],
                    algorithmVersion = it[SleepNightsTable.algorithmVersion],
                    computedAt = it[SleepNightsTable.computedAt].toInstant(),
                )
            }
    }

    fun findCanonicalDatesNeedingRecompute(
        sourceInstanceIds: Set<Int>?,
        dates: Set<LocalDate>,
        timezone: ZoneId,
        algorithmVersion: Int,
    ): Set<LocalDate> {
        if (dates.isEmpty()) return emptySet()
        if (sourceInstanceIds != null && sourceInstanceIds.isEmpty()) return emptySet()

        val rawNightsByDate = listSleepNightsForTimezoneAndDates(
            sourceInstanceIds = sourceInstanceIds,
            timezone = timezone.id,
            dates = dates,
        ).groupBy { it.date }
        val canonicalNightsByDate = listCanonicalSleepNightsForTimezoneAndDates(
            sourceInstanceIds = sourceInstanceIds,
            timezone = timezone.id,
            dates = dates,
        ).groupBy { it.date }

        return dates.filter { date ->
            val rawNights = rawNightsByDate[date].orEmpty()
            val canonicalNights = canonicalNightsByDate[date].orEmpty()
            if (rawNights.isEmpty()) {
                return@filter canonicalNights.isNotEmpty()
            }
            if (canonicalNights.isEmpty()) return@filter true
            if (canonicalNights.any { it.algorithmVersion != algorithmVersion }) return@filter true

            val rawSessionIds = rawNights.map { it.sleepSessionId }.toSet()
            val canonicalSessionIds = canonicalNights.map { it.sleepSessionId }.toSet()
            if (!rawSessionIds.containsAll(canonicalSessionIds)) return@filter true

            val newestRawComputedAt = rawNights.maxOf { it.computedAt }
            canonicalNights.any { it.computedAt.isBefore(newestRawComputedAt) }
        }.toSet()
    }

    private fun listCanonicalSleepNightsForTimezoneAndDates(
        sourceInstanceIds: Set<Int>?,
        timezone: String,
        dates: Set<LocalDate>,
    ): List<SleepNightRecord> {
        if (sourceInstanceIds != null && sourceInstanceIds.isEmpty()) return emptyList()
        if (dates.isEmpty()) return emptyList()

        val conditions = mutableListOf<Op<Boolean>>(
            CanonicalSleepNightsTable.timezone eq timezone,
            CanonicalSleepNightsTable.date inList dates,
        )
        sourceInstanceIds?.let {
            conditions.add(CanonicalSleepNightsTable.sourceInstanceId inList it)
        }

        return CanonicalSleepNightsTable
            .selectAll()
            .where { conditions.reduce { left, right -> left and right } }
            .map {
                SleepNightRecord(
                    sleepSessionId = it[CanonicalSleepNightsTable.sleepSessionId],
                    sourceInstanceId = it[CanonicalSleepNightsTable.sourceInstanceId],
                    date = it[CanonicalSleepNightsTable.date],
                    algorithmVersion = it[CanonicalSleepNightsTable.algorithmVersion],
                    computedAt = it[CanonicalSleepNightsTable.computedAt].toInstant(),
                )
            }
    }

    fun listSleepSessionsForCanonicalNights(
        sourceInstanceIds: Set<Int>?,
        timezone: ZoneId,
        date: LocalDate,
    ): Pair<List<SleepSessionRow>, Map<Int, List<SleepStageRow>>> {
        if (sourceInstanceIds != null && sourceInstanceIds.isEmpty()) {
            return emptyList<SleepSessionRow>() to emptyMap()
        }

        val conditions = mutableListOf<Op<Boolean>>(
            SleepNightsTable.timezone eq timezone.id,
            SleepNightsTable.date eq date,
        )
        sourceInstanceIds?.let {
            conditions.add(SleepNightsTable.sourceInstanceId inList it)
        }

        val sessions = SleepNightsTable
            .innerJoin(SleepSessionsTable)
            .selectAll()
            .where { conditions.reduce { left, right -> left and right } }
            .orderBy(SleepSessionsTable.startAt to SortOrder.ASC, SleepSessionsTable.id to SortOrder.ASC)
            .map {
                SleepSessionRow(
                    id = it[SleepSessionsTable.id].value,
                    sourceInstanceId = it[SleepSessionsTable.sourceInstanceId],
                    startAt = it[SleepSessionsTable.startAt].toApiString(),
                    endAt = it[SleepSessionsTable.endAt].toApiString(),
                    durationSeconds = it[SleepSessionsTable.durationSeconds],
                )
            }

        return sessions to sleepStagesBySession(sessions.map { it.id })
    }

    fun listCanonicalSleepSessionsForCanonicalNights(
        sourceInstanceIds: Set<Int>?,
        timezone: ZoneId,
        date: LocalDate,
    ): List<SleepSessionRow> {
        if (sourceInstanceIds != null && sourceInstanceIds.isEmpty()) {
            return emptyList()
        }

        val conditions = mutableListOf<Op<Boolean>>(
            SleepNightsTable.timezone eq timezone.id,
            SleepNightsTable.date eq date,
        )
        sourceInstanceIds?.let {
            conditions.add(SleepNightsTable.sourceInstanceId inList it)
        }

        return SleepNightsTable
            .innerJoin(SleepSessionsTable, onColumn = { sleepSessionId }, otherColumn = { id })
            .innerJoin(me.aquitano.health.infrastructure.database.tables.CanonicalSleepSessionsTable, onColumn = { SleepSessionsTable.id }, otherColumn = { sleepSessionId })
            .selectAll()
            .where { conditions.reduce { left, right -> left and right } }
            .orderBy(SleepSessionsTable.startAt to SortOrder.ASC, SleepSessionsTable.id to SortOrder.ASC)
            .map {
                SleepSessionRow(
                    id = it[SleepSessionsTable.id].value,
                    sourceInstanceId = it[SleepSessionsTable.sourceInstanceId],
                    startAt = it[SleepSessionsTable.startAt].toApiString(),
                    endAt = it[SleepSessionsTable.endAt].toApiString(),
                    durationSeconds = it[SleepSessionsTable.durationSeconds],
                )
            }
    }

    fun replaceCanonicalSleepNights(
        date: LocalDate,
        timezone: ZoneId,
        sourceInstanceIds: Set<Int>?,
        algorithmVersion: Int,
        computedAt: Instant,
        sessions: List<SleepSessionRow>,
    ): Int {
        if (sourceInstanceIds != null && sourceInstanceIds.isEmpty()) {
            return 0
        }

        CanonicalSleepNightsTable.deleteWhere {
            val base =
                (CanonicalSleepNightsTable.timezone eq timezone.id) and
                    (CanonicalSleepNightsTable.date eq date) and
                    (CanonicalSleepNightsTable.algorithmVersion eq algorithmVersion)
            sourceInstanceIds?.let {
                base and (CanonicalSleepNightsTable.sourceInstanceId inList it)
            } ?: base
        }

        sessions.forEach { session ->
            CanonicalSleepNightsTable.upsert(
                CanonicalSleepNightsTable.timezone,
                CanonicalSleepNightsTable.sleepSessionId,
                CanonicalSleepNightsTable.algorithmVersion,
                onUpdate = {
                    it[CanonicalSleepNightsTable.date] = insertValue(CanonicalSleepNightsTable.date)
                    it[CanonicalSleepNightsTable.sourceInstanceId] =
                        insertValue(CanonicalSleepNightsTable.sourceInstanceId)
                    it[CanonicalSleepNightsTable.computedAt] =
                        insertValue(CanonicalSleepNightsTable.computedAt)
                },
            ) {
                it[this.date] = date
                it[this.timezone] = timezone.id
                it[this.sourceInstanceId] = session.sourceInstanceId
                it[this.sleepSessionId] = session.id
                it[this.algorithmVersion] = algorithmVersion
                it[this.computedAt] = computedAt.toDbTimestamp()
            }
        }

        return sessions.size
    }

    fun sourceMetadataFor(sourceIds: Set<Int>): Map<Int, SourceMetadata> {
        if (sourceIds.isEmpty()) return emptyMap()
        return SourceInstancesTable
            .innerJoin(SourcesTable)
            .select(
                SourceInstancesTable.id,
                SourcesTable.code,
                SourceInstancesTable.providerInstanceId,
            )
            .where { SourceInstancesTable.id inList sourceIds }
            .associate {
                it[SourceInstancesTable.id].value to SourceMetadata(
                    provider = it[SourcesTable.code],
                    providerInstanceId = it[SourceInstancesTable.providerInstanceId],
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
                valueTransform = {
                    SleepStageRow(
                        stage = it[SleepStagesTable.stage],
                        startAt = it[SleepStagesTable.startAt].toApiString(),
                        endAt = it[SleepStagesTable.endAt].toApiString(),
                        durationSeconds = it[SleepStagesTable.durationSeconds],
                    )
                },
            )
    }

    fun replaceSleepNights(output: SleepNightOutput): Int {
        val timezone = output.timezone.id

        if (output.sourceInstanceIds != null && output.sourceInstanceIds.isEmpty()) {
            return 0
        }

        SleepNightsTable.deleteWhere {
            val base =
                (SleepNightsTable.timezone eq timezone) and
                    (SleepNightsTable.date eq output.date)
            output.sourceInstanceIds?.let {
                base and (SleepNightsTable.sourceInstanceId inList it)
            } ?: base
        }

        output.nights.forEach { night ->
            SleepNightsTable.upsert(
                SleepNightsTable.timezone,
                SleepNightsTable.sleepSessionId,
                onUpdate = {
                    it[SleepNightsTable.date] = insertValue(SleepNightsTable.date)
                    it[SleepNightsTable.sourceInstanceId] =
                        insertValue(SleepNightsTable.sourceInstanceId)
                    it[SleepNightsTable.algorithmVersion] =
                        insertValue(SleepNightsTable.algorithmVersion)
                    it[SleepNightsTable.computedAt] =
                        insertValue(SleepNightsTable.computedAt)
                },
            ) {
                it[date] = output.date
                it[this.timezone] = timezone
                it[sourceInstanceId] = night.sourceInstanceId
                it[sleepSessionId] = night.sleepSessionId
                it[algorithmVersion] = output.algorithmVersion
                it[computedAt] = output.computedAt.toDbTimestamp()
            }
        }

        return output.nights.size
    }
}

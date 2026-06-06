package me.aquitano.health.application.metric.sleep.repository

import me.aquitano.health.application.metric.common.repository.ReadFilters
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.infrastructure.database.tables.CanonicalSleepSummariesTable
import me.aquitano.health.infrastructure.database.tables.SleepSummariesTable
import me.aquitano.health.infrastructure.database.toApiString
import me.aquitano.health.infrastructure.database.toDbTimestamp
import me.aquitano.health.infrastructure.repositories.common.BaseMetricRepository
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.jdbc.batchInsert
import org.jetbrains.exposed.v1.jdbc.deleteWhere
import org.jetbrains.exposed.v1.jdbc.selectAll
import java.time.Instant
import java.time.LocalDate

data class CanonicalSleepSummaryRowOutput(
    val sleepSummaryId: Int,
    val sourceInstanceId: Int,
    val startAt: Instant,
    val endAt: Instant,
)

data class CanonicalSleepSummaryOutput(
    val date: LocalDate,
    val algorithmVersion: Int,
    val computedAt: Instant,
    val summaries: List<CanonicalSleepSummaryRowOutput>,
)

class CanonicalSleepSummaryDerivationRepository : BaseMetricRepository() {
    fun listRawSummariesForDay(dayStart: Instant, dayEnd: Instant): List<SleepSummaryRow> =
        SleepSummariesTable.selectAll()
            .where {
                (SleepSummariesTable.startAt greaterEq dayStart.toDbTimestamp()) and
                    (SleepSummariesTable.startAt less dayEnd.toDbTimestamp())
            }
            .orderBy(SleepSummariesTable.startAt to SortOrder.ASC, SleepSummariesTable.id to SortOrder.ASC)
            .map(::toSleepSummaryRow)

    fun persistCanonicalOutput(output: CanonicalSleepSummaryOutput): Int {
        CanonicalSleepSummariesTable.deleteWhere {
            (CanonicalSleepSummariesTable.date eq output.date) and
                (CanonicalSleepSummariesTable.algorithmVersion eq output.algorithmVersion)
        }
        if (output.summaries.isEmpty()) {
            return 0
        }
        CanonicalSleepSummariesTable.batchInsert(output.summaries) { summary ->
            this[CanonicalSleepSummariesTable.date] = output.date
            this[CanonicalSleepSummariesTable.sourceInstanceId] = summary.sourceInstanceId
            this[CanonicalSleepSummariesTable.sleepSummaryId] = summary.sleepSummaryId
            this[CanonicalSleepSummariesTable.startAt] = summary.startAt.toDbTimestamp()
            this[CanonicalSleepSummariesTable.endAt] = summary.endAt.toDbTimestamp()
            this[CanonicalSleepSummariesTable.algorithmVersion] = output.algorithmVersion
            this[CanonicalSleepSummariesTable.computedAt] = output.computedAt.toDbTimestamp()
        }
        return output.summaries.size
    }

    fun listCanonicalSleepSummaries(
        filters: ReadFilters,
        algorithmVersion: Int,
    ): Pair<List<SleepSummaryRow>, Map<Int, SourceMetadata>> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = CanonicalSleepSummariesTable.sourceInstanceId,
            fromColumn = CanonicalSleepSummariesTable.startAt,
        ).whereOrNull() ?: return emptyReadResult()

        val rows = CanonicalSleepSummariesTable
            .innerJoin(SleepSummariesTable, { sleepSummaryId }, { SleepSummariesTable.id })
            .selectAll()
            .where(where and (CanonicalSleepSummariesTable.algorithmVersion eq algorithmVersion))
            .orderBy(
                CanonicalSleepSummariesTable.endAt to filters.sortOrder(),
                SleepSummariesTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map(::toJoinedSleepSummaryRow)
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
    }

    fun latestCanonicalSleepSummary(
        filters: ReadFilters,
        algorithmVersion: Int,
    ): Pair<SleepSummaryRow?, Map<Int, SourceMetadata>> {
        val (rows, sourceMetadata) = listCanonicalSleepSummaries(
            filters.copy(limit = 1, order = "desc"),
            algorithmVersion,
        )
        return rows.singleOrNull() to sourceMetadata
    }

    private fun toJoinedSleepSummaryRow(row: ResultRow): SleepSummaryRow =
        toSleepSummaryRow(row)

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
}

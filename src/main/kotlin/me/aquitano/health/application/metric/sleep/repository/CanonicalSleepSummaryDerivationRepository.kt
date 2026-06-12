package me.aquitano.health.application.metric.sleep.repository

import me.aquitano.health.application.metric.common.keysetFetchLimit
import me.aquitano.health.application.metric.common.repository.ReadFilters
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.infrastructure.database.tables.CanonicalSleepSummariesTable
import me.aquitano.health.infrastructure.database.tables.SleepSummariesTable
import me.aquitano.health.infrastructure.database.toApiString
import me.aquitano.health.infrastructure.repositories.common.BaseMetricRepository
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.jdbc.selectAll

/** Reads through the canonical_sleep_summaries view (rank winner per UTC start date, see V15). */
class CanonicalSleepSummaryDerivationRepository : BaseMetricRepository() {
    fun listCanonicalSleepSummaries(
        filters: ReadFilters,
    ): Pair<List<SleepSummaryRow>, Map<Int, SourceMetadata>> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = CanonicalSleepSummariesTable.sourceInstanceId,
            fromColumn = CanonicalSleepSummariesTable.startAt,
        ).whereOrNull() ?: return emptyReadResult()

        val keyset = timestampKeyset(
            filters.cursor,
            filters.order,
            CanonicalSleepSummariesTable.endAt,
            SleepSummariesTable.id,
        )
        val rows = CanonicalSleepSummariesTable
            .innerJoin(SleepSummariesTable, { sleepSummaryId }, { SleepSummariesTable.id })
            .selectAll()
            .where(keyset?.let { where and it } ?: where)
            .orderBy(
                CanonicalSleepSummariesTable.endAt to filters.sortOrder(),
                SleepSummariesTable.id to filters.sortOrder(),
            )
            .limit(keysetFetchLimit(filters.limit))
            .map(::toJoinedSleepSummaryRow)
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
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

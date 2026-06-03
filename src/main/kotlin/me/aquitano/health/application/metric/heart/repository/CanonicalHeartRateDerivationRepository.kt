package me.aquitano.health.application.metric.heart.repository

import me.aquitano.health.application.metric.common.repository.ReadFilters
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.application.metric.heart.derived.CanonicalHeartRateOutput
import me.aquitano.health.infrastructure.database.tables.CanonicalHeartRateSamplesTable
import me.aquitano.health.infrastructure.database.tables.HeartRateSamplesTable
import me.aquitano.health.infrastructure.database.toApiString
import me.aquitano.health.infrastructure.database.toDbTimestamp
import me.aquitano.health.infrastructure.repositories.common.BaseMetricRepository
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.jdbc.*
import java.time.Instant
import java.time.LocalDate

class CanonicalHeartRateDerivationRepository : BaseMetricRepository() {
    fun listRawSamplesForDay(dayStart: Instant, dayEnd: Instant): List<HeartRateSampleRow> =
        HeartRateSamplesTable.selectAll()
            .where {
                (HeartRateSamplesTable.measuredAt greaterEq dayStart.toDbTimestamp()) and
                    (HeartRateSamplesTable.measuredAt less dayEnd.toDbTimestamp())
            }
            .orderBy(HeartRateSamplesTable.measuredAt to SortOrder.ASC, HeartRateSamplesTable.id to SortOrder.ASC)
            .map(::toHeartRateSampleRow)

    fun persistCanonicalSamples(output: CanonicalHeartRateOutput): Int {
        CanonicalHeartRateSamplesTable.deleteWhere {
            (CanonicalHeartRateSamplesTable.date eq output.date) and
                (CanonicalHeartRateSamplesTable.algorithmVersion eq output.algorithmVersion)
        }
        CanonicalHeartRateSamplesTable.batchInsert(output.samples) { sample ->
            this[CanonicalHeartRateSamplesTable.date] = output.date
            this[CanonicalHeartRateSamplesTable.sourceInstanceId] = sample.sourceInstanceId
            this[CanonicalHeartRateSamplesTable.heartRateSampleId] = sample.sampleId
            this[CanonicalHeartRateSamplesTable.measuredAt] = sample.measuredAt.toDbTimestamp()
            this[CanonicalHeartRateSamplesTable.context] = sample.context
            this[CanonicalHeartRateSamplesTable.algorithmVersion] = output.algorithmVersion
            this[CanonicalHeartRateSamplesTable.computedAt] = output.computedAt.toDbTimestamp()
        }
        return output.samples.size
    }

    fun listCanonicalHeartRateSamples(
        filters: ReadFilters,
        algorithmVersion: Int,
    ): Pair<List<HeartRateSampleRow>, Map<Int, SourceMetadata>> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = CanonicalHeartRateSamplesTable.sourceInstanceId,
            fromColumn = CanonicalHeartRateSamplesTable.measuredAt,
        ).whereOrNull() ?: return emptyReadResult()

        val rows = CanonicalHeartRateSamplesTable
            .innerJoin(
                HeartRateSamplesTable,
                { heartRateSampleId },
                { HeartRateSamplesTable.id },
            )
            .selectAll()
            .where(where and (CanonicalHeartRateSamplesTable.algorithmVersion eq algorithmVersion))
            .orderBy(
                CanonicalHeartRateSamplesTable.measuredAt to filters.sortOrder(),
                HeartRateSamplesTable.id to filters.sortOrder(),
            )
            .limit(filters.limit)
            .map(::toJoinedHeartRateSampleRow)
        return rows to sourceMetadata(rows.map { it.sourceInstanceId }.toSet(), filters.includeSource)
    }

    fun summarizeCanonicalHeartRate(
        filters: ReadFilters,
        algorithmVersion: Int,
    ): HeartRateSummaryRow {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = CanonicalHeartRateSamplesTable.sourceInstanceId,
            fromColumn = CanonicalHeartRateSamplesTable.measuredAt,
        ).whereOrNull() ?: return HeartRateSummaryRow(
            count = 0,
            minBpm = null,
            maxBpm = null,
            avgBpm = null,
        )
        val countExpression = HeartRateSamplesTable.id.count()
        val minExpression = HeartRateSamplesTable.bpm.min()
        val maxExpression = HeartRateSamplesTable.bpm.max()
        val avgExpression = HeartRateSamplesTable.bpm.avg()
        return CanonicalHeartRateSamplesTable
            .innerJoin(
                HeartRateSamplesTable,
                { heartRateSampleId },
                { HeartRateSamplesTable.id },
            )
            .select(countExpression, minExpression, maxExpression, avgExpression)
            .where(where and (CanonicalHeartRateSamplesTable.algorithmVersion eq algorithmVersion))
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

    fun latestCanonicalHeartRateSample(
        filters: ReadFilters,
        algorithmVersion: Int,
    ): Pair<HeartRateSampleRow?, Map<Int, SourceMetadata>> {
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = CanonicalHeartRateSamplesTable.sourceInstanceId,
            fromColumn = CanonicalHeartRateSamplesTable.measuredAt,
        ).whereOrNull() ?: return emptyLatestResult()

        val row = CanonicalHeartRateSamplesTable
            .innerJoin(
                HeartRateSamplesTable,
                { heartRateSampleId },
                { HeartRateSamplesTable.id },
            )
            .selectAll()
            .where(where and (CanonicalHeartRateSamplesTable.algorithmVersion eq algorithmVersion))
            .orderBy(
                CanonicalHeartRateSamplesTable.measuredAt to SortOrder.DESC,
                HeartRateSamplesTable.id to SortOrder.DESC,
            )
            .limit(1)
            .map(::toJoinedHeartRateSampleRow)
            .singleOrNull()
        return row to sourceMetadata(
            listOfNotNull(row?.sourceInstanceId).toSet(),
            filters.includeSource,
        )
    }

    fun materializedDates(dates: Set<LocalDate>, algorithmVersion: Int): Set<LocalDate> {
        if (dates.isEmpty()) return emptySet()
        return CanonicalHeartRateSamplesTable
            .select(CanonicalHeartRateSamplesTable.date)
            .where {
                (CanonicalHeartRateSamplesTable.date inList dates) and
                    (CanonicalHeartRateSamplesTable.algorithmVersion eq algorithmVersion)
            }
            .map { it[CanonicalHeartRateSamplesTable.date] }
            .toSet()
    }

    private fun toJoinedHeartRateSampleRow(row: ResultRow): HeartRateSampleRow =
        HeartRateSampleRow(
            id = row[HeartRateSamplesTable.id].value,
            sourceInstanceId = row[HeartRateSamplesTable.sourceInstanceId],
            measuredAt = row[HeartRateSamplesTable.measuredAt].toApiString(),
            bpm = row[HeartRateSamplesTable.bpm],
            context = row[HeartRateSamplesTable.context] ?: "unknown",
        )

    private fun toHeartRateSampleRow(row: ResultRow): HeartRateSampleRow =
        HeartRateSampleRow(
            id = row[HeartRateSamplesTable.id].value,
            sourceInstanceId = row[HeartRateSamplesTable.sourceInstanceId],
            measuredAt = row[HeartRateSamplesTable.measuredAt].toApiString(),
            bpm = row[HeartRateSamplesTable.bpm],
            context = row[HeartRateSamplesTable.context] ?: "unknown",
        )
}

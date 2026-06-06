package me.aquitano.health.application.metric.sleep.derived

import me.aquitano.health.application.CanonicalMetricsPolicy
import me.aquitano.health.application.metric.common.CanonicalIntervalCandidate
import me.aquitano.health.application.metric.common.canonicalIntervalRows
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.application.metric.sleep.repository.CanonicalSleepSessionDerivationRepository
import me.aquitano.health.application.metric.sleep.repository.CanonicalSleepSessionOutput
import me.aquitano.health.application.metric.sleep.repository.CanonicalSleepSessionRowOutput
import me.aquitano.health.application.metric.sleep.repository.SleepSessionRow
import me.aquitano.health.application.metric.sleep.repository.SleepStageRow
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

const val CANONICAL_SLEEP_SESSION_ALGORITHM_VERSION = 1

class CanonicalSleepSessionDerivationService(
    private val repository: CanonicalSleepSessionDerivationRepository,
    private val policy: CanonicalMetricsPolicy = CanonicalMetricsPolicy.default(),
) {
    suspend fun recompute(dates: Set<LocalDate>, computedAt: Instant) {
        dates.forEach { date ->
            val dayStart = date.atStartOfDay().toInstant(ZoneOffset.UTC)
            val dayEnd = date.plusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC)
            val rawSessions = repository.listRawSessionsForDay(dayStart, dayEnd)
            val stagesBySession = repository.listRawStagesForSessions(rawSessions.map { it.id }.toSet())
            val metadata = repository.sourceMetadataFor(rawSessions.map { it.sourceInstanceId }.toSet())
            
            val canonical = canonicalSleepSessions(rawSessions, stagesBySession, metadata)
            
            repository.persistCanonicalOutput(
                CanonicalSleepSessionOutput(
                    date = date,
                    algorithmVersion = CANONICAL_SLEEP_SESSION_ALGORITHM_VERSION,
                    computedAt = computedAt,
                    sessions = canonical.map {
                        CanonicalSleepSessionRowOutput(
                            sleepSessionId = it.id,
                            sourceInstanceId = it.sourceInstanceId,
                            startAt = Instant.parse(it.startAt),
                            endAt = Instant.parse(it.endAt),
                        )
                    },
                )
            )
        }
    }

    fun canonicalSleepSessions(
        rows: List<SleepSessionRow>,
        stagesBySession: Map<Int, List<SleepStageRow>>,
        metadata: Map<Int, SourceMetadata>,
    ): List<SleepSessionRow> {
        val stageStatsBySession = stagesBySession.mapValues { (_, stages) ->
            SleepStageStats(
                count = stages.size,
                knownStageCount = stages.map { it.stage }.filterNot { it == "unknown" }.toSet().size,
            )
        }
        val candidates = rows.map {
            preparedCanonicalSession(it, metadata, stageStatsBySession[it.id] ?: SleepStageStats(0, 0))
        }.sortedWith(compareBy<PreparedCanonicalSleepSession> { it.candidate.startAt }
            .thenBy { it.candidate.endAt }
            .thenBy { it.candidate.row.id })
            
        val canonical = canonicalIntervalRows(
            rows = candidates.map { it.candidate },
            overlaps = { left, right ->
                val leftPrepared = candidates.first { it.candidate === left }
                val rightPrepared = candidates.first { it.candidate === right }
                sleepOverlaps(leftPrepared, rightPrepared)
            },
            choosePreferred = { left, right ->
                val leftPrepared = candidates.first { it.candidate === left }
                val rightPrepared = candidates.first { it.candidate === right }
                listOf(leftPrepared, rightPrepared).maxWithOrNull(
                    compareBy<PreparedCanonicalSleepSession> { it.stageStats.count }
                        .thenBy { it.stageStats.knownStageCount }
                        .thenBy { it.durationSeconds == it.candidate.row.durationSeconds }
                        .thenBy { -it.providerRank }
                        .thenBy { -it.candidate.row.id }
                )!!.candidate
            }
        )
        return candidates.filter { canonical.contains(it.candidate.row) }.map { it.candidate.row }
    }

    private fun preparedCanonicalSession(
        row: SleepSessionRow,
        metadata: Map<Int, SourceMetadata>,
        stageStats: SleepStageStats,
    ): PreparedCanonicalSleepSession {
        val startAt = Instant.parse(row.startAt)
        val endAt = Instant.parse(row.endAt)
        return PreparedCanonicalSleepSession(
            candidate = CanonicalIntervalCandidate(
                row = row,
                sourceInstanceId = row.sourceInstanceId,
                startAt = startAt,
                endAt = endAt,
            ),
            durationSeconds = Duration.between(startAt, endAt).seconds,
            providerRank = policy.rank(me.aquitano.health.application.CanonicalMetricFamily.SLEEP, metadata[row.sourceInstanceId]?.provider),
            stageStats = stageStats,
        )
    }

    private fun sleepOverlaps(left: PreparedCanonicalSleepSession, right: PreparedCanonicalSleepSession): Boolean {
        val overlap = overlapSeconds(
            left.candidate.startAt,
            left.candidate.endAt,
            right.candidate.startAt,
            right.candidate.endAt,
        )
        if (overlap <= 0) return false
        val shorter = minOf(left.durationSeconds, right.durationSeconds)
        return overlap >= SleepOverlapMinimumSeconds || overlap.toDouble() / shorter.toDouble() >= 0.5
    }

    private fun overlapSeconds(
        leftStart: Instant,
        leftEnd: Instant,
        rightStart: Instant,
        rightEnd: Instant,
    ): Long {
        val start = maxOf(leftStart, rightStart)
        val end = minOf(leftEnd, rightEnd)
        return if (start.isBefore(end)) Duration.between(start, end).seconds else 0
    }

    private companion object {
        const val SleepOverlapMinimumSeconds = 30L * 60L
    }
}

private data class SleepStageStats(
    val count: Int,
    val knownStageCount: Int,
)

private data class PreparedCanonicalSleepSession(
    val candidate: CanonicalIntervalCandidate<SleepSessionRow>,
    val durationSeconds: Long,
    val providerRank: Int,
    val stageStats: SleepStageStats,
)

package me.aquitano.health.application.metric.common

import java.time.Duration
import java.time.Instant

private const val SameTimestampToleranceSeconds = 30L

data class CanonicalTimedRow<T, K>(
    val row: T,
    val key: K,
    val measuredAt: Instant,
)

private data class CanonicalTimestampBucket<T>(
    val representativeAt: Instant,
    val rows: MutableList<T> = mutableListOf(),
)

fun <T, K> canonicalTimestampRows(
    rows: List<T>,
    measuredAt: (T) -> Instant,
    groupKey: (T) -> K,
    sourceInstanceId: (T) -> Int,
    choosePreferred: (List<T>) -> T,
): List<T> {
    val timedRows = rows
        .map { row ->
            CanonicalTimedRow(
                row = row,
                key = groupKey(row),
                measuredAt = measuredAt(row),
            )
        }
        .sortedBy { it.measuredAt }

    val bucketsByKey = mutableMapOf<K, MutableList<CanonicalTimestampBucket<T>>>()

    for (timedRow in timedRows) {
        val bucketsForKey = bucketsByKey.getOrPut(timedRow.key) { mutableListOf() }
        // Rows arrive time-sorted, so representatives of consecutive buckets for a key are
        // more than the tolerance apart; a row within tolerance can only match the last bucket.
        val lastBucket = bucketsForKey.lastOrNull()
        if (lastBucket != null &&
            Duration.between(lastBucket.representativeAt, timedRow.measuredAt).seconds <= SameTimestampToleranceSeconds
        ) {
            lastBucket.rows += timedRow.row
        } else {
            bucketsForKey += CanonicalTimestampBucket(
                representativeAt = timedRow.measuredAt,
                rows = mutableListOf(timedRow.row),
            )
        }
    }

    return bucketsByKey.values
        .flatten()
        .flatMap { bucket ->
            if (bucket.rows.map(sourceInstanceId).toSet().size <= 1) {
                bucket.rows
            } else {
                listOf(choosePreferred(bucket.rows))
            }
        }
        .sortedBy(measuredAt)
}

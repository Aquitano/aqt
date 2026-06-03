package me.aquitano.health.application.metric.common

import java.time.Duration
import java.time.Instant
import kotlin.math.abs

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
        .sortedWith(compareBy<T> { measuredAt(it) })
        .map { row ->
            CanonicalTimedRow(
                row = row,
                key = groupKey(row),
                measuredAt = measuredAt(row),
            )
        }

    val bucketsByKey = mutableMapOf<K, MutableList<CanonicalTimestampBucket<T>>>()

    for (timedRow in timedRows) {
        val bucketsForKey = bucketsByKey.getOrPut(timedRow.key) { mutableListOf() }
        val bucket = bucketsForKey.firstOrNull { bucket ->
            abs(Duration.between(bucket.representativeAt, timedRow.measuredAt).seconds) <= SameTimestampToleranceSeconds
        }

        if (bucket == null) {
            bucketsForKey += CanonicalTimestampBucket(
                representativeAt = timedRow.measuredAt,
                rows = mutableListOf(timedRow.row),
            )
        } else {
            bucket.rows += timedRow.row
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

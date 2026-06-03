package me.aquitano.health.application.metric.common

import me.aquitano.health.application.metric.common.repository.SourceMetadata

/**
 * Result of a metric list query.
 *
 * Carries both the data [rows] and the [sourceMetadata] needed to resolve
 * provider information for canonicalization or response enrichment.
 */
data class MetricReadResult<T>(
    val rows: List<T>,
    val sourceMetadata: Map<Int, SourceMetadata>,
)

/**
 * Result of a metric "latest" or single-item query.
 *
 * The [row] may be null when no data matches the filter criteria.
 */
data class MetricLatestResult<T>(
    val row: T?,
    val sourceMetadata: Map<Int, SourceMetadata>,
)

/**
 * Extracts a set of source instance IDs from a list of rows.
 */
fun <T> List<T>.sourceInstanceIds(selector: (T) -> Int): Set<Int> =
    mapTo(linkedSetOf(), selector)

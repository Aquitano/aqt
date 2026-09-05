package me.aquitano.health.domain

import kotlinx.serialization.json.JsonElement
import java.time.Instant

data class ValidatedIngestionBatch(
    val provider: String,
    val providerInstanceId: String,
    val batchExternalId: String?,
    val ingestedAt: Instant,
    val sourcePayload: JsonElement,
    val normalizedPayloadJson: String,
    val records: List<HealthRecord>,
)

/**
 * Created-row counts keyed by [StructuralMetricKinds] constants for structural tables and
 * by metric_type for scalar samples; the map is the wire shape of metricsCreated.
 */
data class MetricCreatedCounts(val counts: Map<String, Int> = emptyMap()) {
    operator fun get(kind: String): Int = counts[kind] ?: 0

    operator fun plus(other: MetricCreatedCounts): MetricCreatedCounts {
        if (other.counts.isEmpty()) return this
        if (counts.isEmpty()) return other
        val merged = counts.toMutableMap()
        other.counts.forEach { (kind, count) -> merged.merge(kind, count, Int::plus) }
        return MetricCreatedCounts(merged)
    }

    companion object {
        fun of(vararg entries: Pair<String, Int>): MetricCreatedCounts =
            MetricCreatedCounts(entries.toMap())
    }
}

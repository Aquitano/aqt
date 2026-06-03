package me.aquitano.health.application

import me.aquitano.health.api.dto.SourceMetadataResponse
import me.aquitano.health.application.metric.common.MetricReadRepository
import me.aquitano.health.application.metric.common.sourceInstanceIds
import me.aquitano.health.application.metric.heart.repository.HeartRateSampleRow
import me.aquitano.health.application.metric.heart.repository.HeartRateSummaryRow
import me.aquitano.health.application.metric.common.repository.SourceMetadata

internal fun <T> List<T>.singleSource(
    includeSource: Boolean,
    repository: MetricReadRepository,
    sourceInstanceId: (T) -> Int,
): SourceMetadataResponse? {
    if (!includeSource) return null
    val ids = sourceInstanceIds(sourceInstanceId)
    if (ids.size != 1) return null
    return repository.sourceMetadataFor(ids)
        .values
        .singleOrNull()
        .toResponse()
}

internal fun List<HeartRateSampleRow>.heartRateSummary(): HeartRateSummaryRow =
    HeartRateSummaryRow(
        count = size,
        minBpm = minOfOrNull { it.bpm },
        maxBpm = maxOfOrNull { it.bpm },
        avgBpm = if (isEmpty()) null else sumOf { it.bpm }.toDouble() / size.toDouble(),
    )

private fun SourceMetadata?.toResponse(): SourceMetadataResponse? =
    this?.let {
        SourceMetadataResponse(
            provider = it.provider,
            providerInstanceId = it.providerInstanceId,
        )
    }

package me.aquitano.health.application

import me.aquitano.health.api.dto.SourceMetadataResponse
import me.aquitano.health.infrastructure.repositories.HeartRateSampleRow
import me.aquitano.health.infrastructure.repositories.HeartRateSummaryRow
import me.aquitano.health.infrastructure.repositories.MetricsReadRepository
import me.aquitano.health.infrastructure.repositories.SourceMetadata

internal fun <T> List<T>.sourceIds(sourceInstanceId: (T) -> Int): Set<Int> =
    map(sourceInstanceId).toSet()

internal fun <T> List<T>.singleSource(
    includeSource: Boolean,
    metricsReadRepository: MetricsReadRepository,
    sourceInstanceId: (T) -> Int,
): SourceMetadataResponse? {
    if (!includeSource) return null
    val sourceIds = sourceIds(sourceInstanceId)
    if (sourceIds.size != 1) return null
    return metricsReadRepository.sourceMetadataFor(sourceIds)
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

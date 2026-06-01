package me.aquitano.health.application.metric.common

import me.aquitano.health.application.metric.common.repository.SourceMetadata

/**
 * Contract for metric-specific read repositories.
 *
 * Every metric repository (e.g. StepSampleRepository, SleepSessionRepository)
 * should expose at least [sourceMetadataFor] so that read services can enrich
 * responses and perform canonicalization.
 */
interface MetricReadRepository {
    /**
     * Returns provider metadata for the given source instance IDs.
     */
    fun sourceMetadataFor(sourceIds: Set<Int>): Map<Int, SourceMetadata>
}

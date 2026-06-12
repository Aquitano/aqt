package me.aquitano.health.application.metric.scalar

import me.aquitano.health.api.dto.ScalarSampleResponse
import me.aquitano.health.api.dto.SourceMetadataResponse
import me.aquitano.health.application.metric.common.repository.SourceMetadata

private fun Map<Int, SourceMetadata>.responseFor(sourceInstanceId: Int): SourceMetadataResponse? =
    this[sourceInstanceId]?.let {
        SourceMetadataResponse(
            provider = it.provider,
            providerInstanceId = it.providerInstanceId,
        )
    }

internal fun ScalarSampleRow.toScalarResponse(
    sourceMetadata: Map<Int, SourceMetadata>,
): ScalarSampleResponse =
    ScalarSampleResponse(
        id = id,
        measuredAt = measuredAt.toString(),
        metricType = metricType,
        value = value,
        unit = unit,
        context = context,
        segment = segment,
        source = sourceMetadata.responseFor(sourceInstanceId),
    )
